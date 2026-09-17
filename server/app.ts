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
  route("post", "/policy/propose", (a, r) => offices.changePolicy(a, r.body));
  route("post", "/cap/propose", (a, r) =>
    offices.changeCap(a, r.body?.monthlyCap),
  );
  route("post", "/close/propose", (a) => offices.close(a));
  route("get", "/proposals", (a) => offices.queue(a), undefined, true);
  route(
    "get",
    "/proposals/:id",
    (a, r) => offices.proposal(a, param(r, "id")),
    undefined,
    true,
  );
  route(
    "post",
    "/proposals/:id/signatures",
    (a, r) => offices.signProposal(a, param(r, "id"), r.body?.signature),
    undefined,
    true,
  );
  route(
    "get",
    "/proposals/:id/execution",
    (a, r) => offices.execution(a, param(r, "id")),
    undefined,
    true,
  );
  route(
    "post",
    "/proposals/:id/confirm",
    (a, r) => offices.confirm(a, param(r, "id"), r.body?.transactionHash),
    undefined,
    true,
  );
  route("get", "/conversations", (a) => conversations.list(a));
  route("post", "/conversations", (a, r) => conversations.create(a, r.body));
  route("get", "/conversations/:id/messages", (a, r) =>
    conversations.messages(a, param(r, "id")),
  );
  route("delete", "/conversations/:id", (a, r) =>
    conversations.remove(a, param(r, "id")),
  );
  route("post", "/quotes", (a, r) => ledger.quote(a, r.body));
  route("post", "/chat", (a, r) => ledger.request(a, r.body));
  route("get", "/requests/:id", (a, r) => ledger.status(a, param(r, "id")));
  route("get", "/ledger", (a, r) =>
    ledger.list(
      a,
      typeof r.query.month === "string" ? r.query.month : undefined,
    ),
  );
  route("get", "/ledger/:id/proof", (a, r) => ledger.proof(a, param(r, "id")));
  route("get", "/ledger/export", async (a, r, res) => {
    const iterator = ledger.statement(
        a,
        typeof r.query.month === "string" ? r.query.month : undefined,
      ),
      first = await iterator.next(),
      csv = r.query.format === "csv";
    const field = (value: unknown) => {
      let text = String(value ?? "");
      if (/^[=+@\-\t\r\n]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    const write = async (text: string) => {
      if (res.destroyed) throw Error("Export connection closed");
      if (res.write(text)) return;
      await new Promise<void>((resolve, reject) => {
        const drain = () => {
          res.off("close", close);
          resolve();
        };
        const close = () => {
          res.off("drain", drain);
          reject(Error("Export connection closed"));
        };
        res.once("drain", drain);
        res.once("close", close);
      });
    };
    res
      .type(csv ? "text/csv" : "application/json")
      .set(
        "Content-Disposition",
        `attachment; filename="chancery-ledger.${csv ? "csv" : "json"}"`,
      );
    let comma = false;
    await write(
      csv
        ? [
            "id",
            "date",
            "actor",
            "model",
            "status",
            "charged_usd",
            "settlement",
          ]
            .map(field)
            .join(",") + "\r\n"
        : "[",
    );
    async function batch(rows: any[]) {
      for (const row of rows) {
        if (csv)
          await write(
            [
              row.id,
              new Date(row.created_at).toISOString(),
              row.envelope.payload.actorId,
              row.envelope.payload.model,
              row.envelope.payload.status,
              row.envelope.payload.chargedUsd,
              row.settlement_id,
            ]
              .map(field)
              .join(",") + "\r\n",
          );
        else {
          await write((comma ? "," : "") + JSON.stringify(row));
          comma = true;
        }
      }
    }
    try {
      if (!first.done) await batch(first.value);
      for await (const rows of iterator) await batch(rows);
      if (!csv) await write("]");
      res.end();
    } catch (error) {
      res.destroy(error instanceof Error ? error : undefined);
    }
  });
  route("post", "/devices", (a, r) => rooms.device(a, r.body), "rooms");
  route(
    "delete",
    "/devices/:id",
    (a, r) => rooms.revokeDevice(a, param(r, "id")),
    "rooms",
  );
  route("get", "/rooms", (a) => rooms.list(a), "rooms");
  route("post", "/rooms", (a, r) => rooms.create(a, r.body), "rooms");
  route(
    "post",
    "/rooms/:id/members",
    (a, r) => rooms.members(a, param(r, "id"), r.body),
    "rooms",
  );
  route(
    "get",
    "/rooms/:id/devices",
    (a, r) => rooms.directory(a, param(r, "id")),
    "rooms",
  );
  route(
    "post",
    "/rooms/:id/rotate",
    (a, r) => rooms.rotate(a, param(r, "id"), r.body),
    "rooms",
  );
  route(
    "get",
    "/rooms/:id/keys/:deviceId",
    (a, r) => rooms.keys(a, param(r, "id"), param(r, "deviceId")),
    "rooms",
  );
  route(
    "get",
    "/rooms/:id/items",
    (a, r) => rooms.items(a, param(r, "id")),
    "rooms",
  );
  route(
    "post",
    "/rooms/:id/items",
    (a, r) => rooms.post(a, param(r, "id"), r.body),
    "rooms",
  );
  route("get", "/clerks", (a) => clerks.list(a), "clerks");
  route("post", "/clerks", (a, r) => clerks.create(a, r.body), "clerks");
  route(
    "post",
    "/clerks/:id/prepare",
    (a, r) => clerks.prepare(a, param(r, "id"), r.body?.chat),
    "clerks",
  );
  route(
    "post",
    "/clerks/:id/run",
    (a, r) => clerks.run(a, param(r, "id"), r.body),
    "clerks",
  );
  route(
    "post",
    "/clerks/:id/pause",
    (a, r) => clerks.pause(a, param(r, "id")),
    "clerks",
  );
  route(
    "post",
    "/clerks/:id/resume",
    (a, r) => clerks.resume(a, param(r, "id")),
    "clerks",
  );
  route(
    "post",
    "/clerks/:id/revoke",
    (a, r) => clerks.revoke(a, param(r, "id")),
    "clerks",
  );
  route("get", "/approvals", (a) => clerks.approvals(a), "clerks");
  route(
    "post",
    "/approvals/:id",
    (a, r) => clerks.decide(a, param(r, "id"), r.body),
    "clerks",
  );
  route(
    "post",
    "/clerks/:id/safe-drafts",
    (a, r) => updates.draft(a, param(r, "id"), r.body),
    "safe_drafts",
  );
  route("post", "/minutes", (a, r) => updates.minutes(a, r.body), "minutes");
  route("get", "/minutes", (a) => updates.listMinutes(a), "minutes");
  route("get", "/benefits", (a) => updates.benefits(a), "token_benefits");
  
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
