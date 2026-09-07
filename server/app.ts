import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { privateKeyToAccount } from "viem/accounts";
import cookieParser from "cookie-parser";
import { ZodError } from "zod";
import { UPDATES, type UpdateId } from "../shared/releases.ts";
import { ADDRESSES } from "../shared/chain.ts";
import { ApiError, assert } from "./errors.ts";
import { registerAuth } from "./auth.ts";
import { openDatabase, type Database } from "./db.ts";
import { config, type Config } from "./config.ts";
import { createChain, type Chain } from "./chain.ts";
import {
  createCrypto,
  type CryptoService,
  MerkleTree,
  envelopeLeaf,
} from "./crypto.ts";
import { createProvider, type Provider } from "./provider.ts";
import { createOffices, type Access } from "./offices.ts";
import { createLedger } from "./ledger.ts";
import { createRooms } from "./rooms.ts";
import { createClerks } from "./clerks.ts";
import { createConversations } from "./conversations.ts";
import { createUpdates } from "./updates.ts";
import { registerWeb } from "./web.ts";
export async function createApp(
  deps: {
    cfg?: Config;
    db?: Database;
    chain?: Chain;
    crypto?: CryptoService;
    provider?: Provider;
  } = {},
) {
  const cfg = deps.cfg || config(),
    db = deps.db || (await openDatabase(cfg.databaseUrl));
  if (cfg.migrateOnStart) await db.migrate();
  const chain = deps.chain || createChain(cfg),
    crypto = deps.crypto || (await createCrypto(cfg, db)),
    provider = deps.provider || createProvider(cfg);
  const offices = createOffices(db, cfg, chain, crypto),
    ledger = createLedger(db, cfg, chain, crypto, offices, provider),
    rooms = createRooms(db, crypto),
    clerks = createClerks(db, cfg, chain, crypto, offices, ledger),
    updates = createUpdates(db, cfg, chain, crypto, offices, clerks);
  const conversations = createConversations(db, crypto);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", cfg.production ? 1 : false);
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    });
    if (cfg.production)
      res.set("Strict-Transport-Security", "max-age=31536000");
    const origin = req.headers.origin;
    if (origin && origin !== cfg.origin)
      return next(
        new ApiError(403, "origin_denied", "This origin is not allowed."),
      );
    if (origin) {
      res.set({
        "Access-Control-Allow-Origin": cfg.origin,
        "Access-Control-Allow-Credentials": "true",
        Vary: "Origin",
      });
    }
    if (req.method === "OPTIONS") {
      res.set({
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,X-CSRF-Token",
      });
      return res.status(204).end();
    }
    if (!["GET", "HEAD"].includes(req.method) && origin !== cfg.origin)
      return next(
        new ApiError(
          403,
          "origin_required",
          "Send requests from the configured application origin.",
        ),
      );
    next();
  });
  const buckets = new Map<string, { count: number; until: number }>();
  app.use("/api", (req, res, next) => {
    const now = Date.now(),
      key = `${req.ip}:${req.path.startsWith("/auth") ? "auth" : "api"}`,
      limit = req.path.startsWith("/auth") ? 40 : 240;
    let bucket = buckets.get(key);
    if (!bucket || bucket.until < now) {
      bucket = { count: 0, until: now + 60000 };
      buckets.set(key, bucket);
    }
    if (buckets.size > 10000)
      for (const [id, item] of buckets)
        if (item.until < now) buckets.delete(id);
    if (++bucket.count > limit) {
      res.set("Retry-After", "60");
      return next(
        new ApiError(
          429,
          "rate_limited",
          "Too many requests. Try again shortly.",
        ),
      );
    }
    next();
  });
  app.use(express.json({ limit: "1mb", strict: true }));
  app.use(cookieParser());
  registerWeb(app);
  app.get("/health", (_req, res) =>
    res.json({ status: "ok", service: "chancery-backend" }),
  );
  app.get("/ready", async (_req, res) => {
    let database = false,
      network = false,
      operator = false,
      worker = false;
    try {
      await db.query("SELECT version FROM chancery_schema");
      database = true;
      if (cfg.registry) {
        const state = await chain.configuration();
        network = true;
        if (cfg.settlerKey)
          operator =
            privateKeyToAccount(
              cfg.settlerKey as `0x${string}`,
            ).address.toLowerCase() === state.operator.toLowerCase();
      }
    } catch {}
    try {
      const [lease] = await db.query(
        "SELECT id FROM worker_leases WHERE id='settler' AND heartbeat_at>now()-interval '90 seconds'",
      );
      worker = !!lease;
    } catch {}
    const ready = database && network && !!cfg.providerKey && operator && worker;
    res.status(ready ? 200 : 503).json({
      ready,
      database,
      mainnet: network,
      providerConfigured: !!cfg.providerKey,
      settlerConfigured: !!cfg.settlerKey,
      operatorMatches: operator,
      workerHealthy: worker,
    });
  });
  app.get("/api/config", (_req, res) =>
    res.json({
      chainId: 4663,
      registry: cfg.registry || null,
      token: cfg.tokenAddress || null,
      addresses: ADDRESSES,
      updates: UPDATES.map((u) => ({ ...u, enabled: cfg.released.has(u.id) })),
      aiProvider: "PROVIDER",
      privacy: {
        standard:
          "Encrypted storage; messages sent to the selected model provider.",
        zero_retention:
          "Available only for operator-verified models; responses are not stored by Chancery.",
        sealed:
          "Room ciphertext is stored without server decryption keys. Sealed AI inference is not available.",
      },
    }),
  );
  app.get("/api/receipt-keys", async (_req, res) =>
    res.json(
      await db.query(
        "SELECT id,public_key,created_at FROM receipt_keys ORDER BY created_at",
      ),
    ),
  );
  app.post("/api/verify", async (req, res) => {
    const valid = await crypto.verify(req.body?.envelope);
    let proofValid: null | boolean = null;
    const proof = req.body?.proof;
    if (proof !== undefined) {
      assert(
        Array.isArray(proof) &&
          proof.length <= 64 &&
          proof.every((x) => /^0x[0-9a-f]{64}$/i.test(x)) &&
          /^0x[0-9a-f]{64}$/i.test(req.body?.leaf) &&
          /^0x[0-9a-f]{64}$/i.test(req.body?.root),
        400,
        "proof_invalid",
        "Invalid Merkle proof.",
      );
      proofValid =
        valid &&
        envelopeLeaf(req.body.envelope) === req.body.leaf &&
        MerkleTree.verify(req.body.leaf, proof, req.body.root);
    }
    res.json({ valid, proofValid, anchorVerified: false });
  });
  const auth = registerAuth(app, db, cfg, chain.verifyWallet);
  app.use("/api", auth.authenticated);
  app.use("/api", (req, res, next) =>
    ["GET", "HEAD"].includes(req.method) ? next() : auth.csrf(req, res, next),
  );
  app.get("/api/models", async (_req, res) =>
    res.json(await provider.catalog()),
  );
  app.get("/api/offices", async (req, res) =>
    res.json(await offices.list(req.account!)),
  );
  app.post("/api/offices", async (req, res) =>
    res.status(201).json(await offices.create(req.account!, req.body)),
  );
  app.post("/api/offices/:officeId/claim", async (req, res) =>
    res.json(
      await offices.claim(
        req.account!,
        String(req.params.officeId),
        req.body?.token,
      ),
    ),
  );
  type Handler = (a: Access, req: Request, res: Response) => Promise<any>;
  const route = (
    method: "get" | "post" | "delete",
    path: string,
    fn: Handler,
    gate?: UpdateId,
    allowPending = false,
  ) => {
    app[method](`/api/offices/:officeId${path}`, async (req, res) => {
      if (gate)
        assert(
          cfg.released.has(gate),
          404,
          "update_unavailable",
          "This update has not been released.",
        );
      const a = await offices.access(
        req.account!,
        String(req.params.officeId),
        undefined,
        allowPending,
      );
      const result = await fn(a, req, res);
      if (!res.headersSent) res.json(result);
    });
  };
  const param = (req: Request, name: string) => String(req.params[name]);
  route("get", "", (a) => offices.get(a), undefined, true);
  route("get", "/seats", (a) => offices.seats(a), undefined, true);
  route(
    "post",
    "/open/propose",
    (a) => offices.reopenProposal(a),
    undefined,
    true,
  );
  route(
    "post",
    "/proposals/:id/refresh",
    (a, r) => offices.refreshProposal(a, param(r, "id")),
    undefined,
    true,
  );
  route("post", "/seats/propose", (a, r) => offices.changeSeats(a, r.body));
  route("post", "/invites", (a, r) => offices.invite(a, r.body));
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  app.use((_req, _res, next) =>
    next(new ApiError(404, "not_found", "Endpoint not found.")),
  );
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return res.end();
    if (error instanceof ApiError)
      return res
        .status(error.status)
        .json({ error: { code: error.code, message: error.message } });
    if (error instanceof ZodError)
      return res.status(400).json({
        error: {
          code: "input_invalid",
          message: "Check the request fields.",
          fields: error.issues.map((x) => ({
            path: x.path.join("."),
            message: x.message,
          })),
        },
      });
    if (error?.type === "entity.too.large")
      return res.status(413).json({
        error: { code: "body_too_large", message: "Request is too large." },
      });
    if (error instanceof SyntaxError)
      return res.status(400).json({
        error: { code: "json_invalid", message: "Request JSON is invalid." },
      });
    // Do not log prompts, credentials, wallet signatures, or upstream response bodies.
    console.error(
      JSON.stringify({
        event: "request_error",
        name: error?.name || "Error",
        code: typeof error?.code === "string" ? error.code : undefined,
      }),
    );
    res.status(500).json({
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
      },
    });
  });
  return {
    app,
    cfg,
    db,
    chain,
    crypto,
    offices,
    ledger,
    provider,
    rooms,
    clerks,
    updates,
    conversations,
  };
}
