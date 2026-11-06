import express from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Database } from "./db.ts";
import type { Config } from "./config.ts";
import type { CryptoService } from "./crypto.ts";
import type { Access } from "./offices.ts";
import { hash } from "./crypto.ts";
import { ApiError, assert } from "./errors.ts";
import { MCP_SCOPES } from "../shared/mcp.ts";
import { checkGuards } from "../shared/guards.ts";
const random = () => randomBytes(32).toString("base64url");
const opaque = z.string().regex(/^[A-Za-z0-9_-]{32,100}$/);
const names = MCP_SCOPES.map((s) => s.id);
export function createOAuth(
  db: Database,
  cfg: Config,
  crypto: CryptoService,
  mcp: {
    create: (a: Access, b: unknown) => Promise<any>;
    revoke: (a: Access, id: string) => Promise<any>;
  },
) {
  const router = express.Router();
  const resource = () => cfg.origin + "/mcp";
  const enabled = () =>
    assert(
      cfg.released.has("mcp"),
      404,
      "update_unavailable",
      "Agents is unavailable.",
    );
  async function rate(key: string, limit = 40) {
    const [r] = await db.query(
      "INSERT INTO mcp_rate_limits(key,count,expires_at) VALUES($1,1,now()+interval '1 hour') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN mcp_rate_limits.expires_at<=now() THEN 1 ELSE mcp_rate_limits.count+1 END,expires_at=CASE WHEN mcp_rate_limits.expires_at<=now() THEN excluded.expires_at ELSE mcp_rate_limits.expires_at END RETURNING count",
      [hash("oauth:" + key)],
    );
    assert(r.count <= limit, 429, "rate_limited", "Please try again later.");
  }
  router.use((req, res, next) => {
    enabled();
    assert(
      req.headers.host === new URL(cfg.origin).host,
      403,
      "host_denied",
      "Invalid host.",
    );
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use(
    express.urlencoded({ extended: false, limit: "12kb" }),
    express.json({ limit: "12kb" }),
  );
  const safeRedirect = (raw: string) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new ApiError(400, "invalid_redirect_uri", "Invalid redirect URI.");
    }
    assert(
      !u.username &&
        !u.password &&
        !u.hash &&
        (u.protocol === "https:" ||
          (u.protocol === "http:" &&
            ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname))),
      400,
      "invalid_redirect_uri",
      "Use HTTPS or a loopback callback.",
    );
    assert(
      !u.searchParams.has("code") &&
        !u.searchParams.has("state") &&
        !u.searchParams.has("iss"),
      400,
      "invalid_redirect_uri",
      "Reserved callback parameters.",
    );
    return raw;
  };
  router.post("/oauth/register", async (req, res) => {
    await rate("register:" + req.ip, 20);
    const b = z
      .object({
        client_name: z.string().trim().min(1).max(80),
        redirect_uris: z.array(z.string().max(2048)).min(1).max(5),
        token_endpoint_auth_method: z.literal("none").default("none"),
        grant_types: z
          .array(z.enum(["authorization_code", "refresh_token"]))
          .default(["authorization_code", "refresh_token"]),
        response_types: z.array(z.literal("code")).default(["code"]),
      })
      .parse(req.body);
    assert(
      !checkGuards(b.client_name),
      400,
      "invalid_client_metadata",
      "Invalid client name.",
    );
    b.redirect_uris.forEach(safeRedirect);
    const id = random();
    await db.query(
      "INSERT INTO agent_oauth_clients(id,name,redirect_uris) VALUES($1,$2,$3)",
      [id, b.client_name, JSON.stringify(b.redirect_uris)],
    );
    res.status(201).json({
      ...b,
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
  });
  router.get("/.well-known/oauth-protected-resource/mcp", (_req, res) =>
    res.json({
      resource: resource(),
      authorization_servers: [cfg.origin],
      scopes_supported: names,
      bearer_methods_supported: ["header"],
    }),
  );
  router.get("/.well-known/oauth-authorization-server", (_req, res) =>
    res.json({
      issuer: cfg.origin,
      authorization_endpoint: cfg.origin + "/oauth/authorize",
      token_endpoint: cfg.origin + "/oauth/token",
      registration_endpoint: cfg.origin + "/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: names,
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: false,
    }),
  );
  router.get("/oauth/authorize", async (req, res) => {
    await rate("authorize:" + req.ip, 80);
    const b = z
      .object({
        client_id: opaque,
        redirect_uri: z.string().max(2048),
        response_type: z.literal("code"),
        code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        code_challenge_method: z.literal("S256"),
        resource: z.string(),
        scope: z.string().max(300).default("workspace:read models:read"),
        state: z.string().max(512).optional(),
      })
      .parse(req.query);
    assert(
      b.resource === resource(),
      400,
      "invalid_target",
      "Choose the Chancery MCP resource.",
    );
    const [client] = await db.query(
      "SELECT * FROM agent_oauth_clients WHERE id=$1",
      [b.client_id],
    );
    assert(
      client && client.redirect_uris.includes(b.redirect_uri),
      400,
      "invalid_redirect_uri",
      "Callback is not registered.",
    );
    const scopes = [...new Set(b.scope.split(" ").filter(Boolean))];
    assert(
      scopes.length > 0 && scopes.every((s) => names.includes(s as any)),
      400,
      "invalid_scope",
      "Unsupported permissions.",
    );
    const id = random();
    await db.query(
      "INSERT INTO agent_oauth_pending(id,client_id,parameters,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
      [id, b.client_id, JSON.stringify({ ...b, scopes })],
    );
    res.redirect(303, cfg.origin + "/app/#/agents?connect=" + id);
  });
  async function pending(id: string) {
    opaque.parse(id);
    const [row] = await db.query(
      "SELECT p.*,c.name FROM agent_oauth_pending p JOIN agent_oauth_clients c ON c.id=p.client_id WHERE p.id=$1 AND p.used_at IS NULL AND p.expires_at>now()",
      [id],
    );
    assert(
      row,
      404,
      "consent_expired",
      "This connection request expired or was already handled. Start again in your AI client.",
    );
    return row;
  }
  async function details(id: string) {
    enabled();
    const row = await pending(id);
    return {
      id,
      name: row.name,
      redirectUri: row.parameters.redirect_uri,
      scopes: row.parameters.scopes,
    };
  }
  async function consent(a: Access, id: string, body: unknown) {
    enabled();
    const b = z
      .strictObject({
        approved: z.boolean(),
        scopes: z.array(z.enum(names as [string, ...string[]])),
        expiresInDays: z.number().int().min(1).max(30),
        budgetUsd: z.string(),
        maxRequestUsd: z.string(),
      })
      .parse(body);
    const row = await pending(id),
      p = row.parameters;
    assert(
      b.scopes.every((s) => p.scopes.includes(s)),
      400,
      "invalid_scope",
      "Consent cannot add permissions the client did not request.",
    );
    const [claimed] = await db.query(
      "UPDATE agent_oauth_pending SET used_at=now() WHERE id=$1 AND used_at IS NULL AND expires_at>now() RETURNING id",
      [id],
    );
    assert(
      claimed,
      409,
      "consent_expired",
      "This request was already handled.",
    );
    const redirect = new URL(p.redirect_uri);
    if (p.state !== undefined) redirect.searchParams.set("state", p.state);
    redirect.searchParams.set("iss", cfg.origin);
    if (!b.approved) {
      redirect.searchParams.set("error", "access_denied");
      return { redirectUri: redirect.href };
    }
    let connection: any;
    try {
      connection = await mcp.create(a, {
        name: row.name,
        scopes: b.scopes,
        expiresInDays: b.expiresInDays,
        budgetUsd: b.budgetUsd,
        maxRequestUsd: b.maxRequestUsd,
      });
      const code = random();
      await db.office(a.office.id, (q) =>
        q.query(
          "UPDATE mcp_connections SET oauth_client_id=$2,token_expires_at=now()+interval '15 minutes' WHERE id=$1",
          [connection.id, row.client_id],
        ),
      );
      await db.query(
        "INSERT INTO agent_oauth_codes(code_hash,client_id,connection_id,office_id,redirect_uri,challenge,token_enc,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '60 seconds')",
        [
          hash(code),
          row.client_id,
          connection.id,
          a.office.id,
          p.redirect_uri,
          p.code_challenge,
          crypto.seal(a.office.id, "oauth-code:" + hash(code), {
            token: connection.token,
          }),
        ],
      );
      redirect.searchParams.set("code", code);
      return { redirectUri: redirect.href };
    } catch (e) {
      if (connection) await mcp.revoke(a, connection.id);
      throw e;
    }
  }
  router.post("/oauth/token", async (req, res) => {
    await rate("token:" + req.ip, 200);
    const b = z
      .object({
        grant_type: z.enum(["authorization_code", "refresh_token"]),
        client_id: opaque,
        resource: z.string(),
        code: opaque.optional(),
        redirect_uri: z.string().max(2048).optional(),
        code_verifier: z
          .string()
          .regex(/^[A-Za-z0-9._~-]{43,128}$/)
          .optional(),
        refresh_token: opaque.optional(),
      })
      .parse(req.body);
    assert(
      b.resource === resource(),
      400,
      "invalid_target",
      "Invalid token audience.",
    );
    const result = await db.transaction(async (q) => {
      let connection: any, access: string;
      if (b.grant_type === "authorization_code") {
        assert(
          b.code && b.code_verifier && b.redirect_uri,
          400,
          "invalid_grant",
          "Missing authorization-code parameters.",
        );
        const [code] = await q.query(
          "SELECT * FROM agent_oauth_codes WHERE code_hash=$1 FOR UPDATE",
          [hash(b.code)],
        );
        assert(
          code &&
            !code.used_at &&
            new Date(code.expires_at).getTime() > Date.now() &&
            code.client_id === b.client_id &&
            code.redirect_uri === b.redirect_uri &&
            code.challenge ===
              createHash("sha256").update(b.code_verifier).digest("base64url"),
          400,
          "invalid_grant",
          "Invalid or expired authorization code.",
        );
        [connection] = await q.query(
          "SELECT * FROM mcp_connections WHERE id=$1 FOR UPDATE",
          [code.connection_id],
        );
        access = crypto.open(
          code.office_id,
          "oauth-code:" + hash(b.code),
          code.token_enc,
        ).token;
        await q.query(
          "UPDATE agent_oauth_codes SET used_at=now(),token_enc=NULL WHERE code_hash=$1",
          [hash(b.code)],
        );
      } else {
        assert(b.refresh_token, 400, "invalid_grant", "Missing refresh token.");
        const [refresh] = await q.query(
          "SELECT * FROM agent_oauth_refresh WHERE token_hash=$1 FOR UPDATE",
          [hash(b.refresh_token)],
        );
        assert(
          refresh &&
            refresh.client_id === b.client_id &&
            new Date(refresh.expires_at).getTime() > Date.now(),
          400,
          "invalid_grant",
          "Invalid refresh token.",
        );
        [connection] = await q.query(
          "SELECT * FROM mcp_connections WHERE id=$1 FOR UPDATE",
          [refresh.connection_id],
        );
        if (refresh.used_at) {
          await q.query(
            "UPDATE mcp_connections SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1",
            [refresh.connection_id],
          );
          return { replay: true } as const;
        }
        await q.query(
          "UPDATE agent_oauth_refresh SET used_at=now() WHERE token_hash=$1",
          [hash(b.refresh_token)],
        );
        access = "ch_mcp_" + random();
      }
      assert(
        connection &&
          !connection.revoked_at &&
          !connection.paused_at &&
          connection.oauth_client_id === b.client_id &&
          new Date(connection.expires_at).getTime() > Date.now(),
        400,
        "invalid_grant",
        "Connection is inactive.",
      );
      const seconds = Math.min(
        900,
        Math.floor(
          (new Date(connection.expires_at).getTime() - Date.now()) / 1000,
        ),
      );
      assert(seconds > 0, 400, "invalid_grant", "Connection expired.");
      const refresh = random();
      await q.query(
        "UPDATE mcp_connections SET token_hash=$2,token_expires_at=now()+($3*interval '1 second') WHERE id=$1",
        [connection.id, hash(access), seconds],
      );
      await q.query(
        "INSERT INTO agent_oauth_refresh(token_hash,client_id,connection_id,expires_at) VALUES($1,$2,$3,$4)",
        [hash(refresh), b.client_id, connection.id, connection.expires_at],
      );
      return {
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: seconds,
        scope: connection.scopes.join(" "),
      };
    });
    assert(
      !("replay" in result),
      400,
      "invalid_grant",
      "Refresh token reuse detected. Reconnect the agent.",
    );
    res.json(result);
  });
  router.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err instanceof ApiError ? err.status : 400).json({
        error: err instanceof ApiError ? err.code : "invalid_request",
        error_description:
          err instanceof ApiError ? err.message : "Invalid OAuth request.",
      });
    },
  );
  return { router, details, consent };
}
