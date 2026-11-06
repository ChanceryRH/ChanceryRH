import test from "node:test";
import assert from "node:assert/strict";
import supertest from "supertest";
import { fixture, MEMBER } from "./fixture.ts";
import { hash } from "../server/crypto.ts";
async function setup(
  scopes = ["workspace:read", "models:read", "requests:prepare"],
) {
  const f = await fixture("mcp"),
    user = await f.login(),
    office = await f.office(user.account);
  const base = "/api/offices/" + office.id + "/mcp";
  const post = (path: string, body: any = {}) =>
    user.agent
      .post(base + path)
      .set("Origin", f.cfg.origin)
      .set("X-CSRF-Token", user.csrf)
      .send(body);
  const created = await post("/connections", { name: "My AI tool", scopes });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const token = created.body.token;
  const rpc = (method: string, params: any = {}, credential = token) =>
    supertest(f.app)
      .post("/mcp")
      .set("Host", "localhost:5180")
      .set("Authorization", "Bearer " + credential)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method, params });
  const call = (name: string, args: any = {}, credential = token) =>
    rpc("tools/call", { name, arguments: args }, credential);
  return {
    ...f,
    makeOffice: f.office,
    user,
    office,
    base,
    post,
    created,
    token,
    rpc,
    call,
  };
}
test("MCP is release-gated; cookie sessions never substitute for bearer credentials", async () => {
  const f = await fixture();
  try {
    assert.equal((await supertest(f.app).post("/mcp").send({})).status, 404);
  } finally {
    await f.db.close();
  }
  const g = await setup();
  try {
    const r = await g.user.agent
      .post("/mcp")
      .set("Host", "localhost:5180")
      .send({});
    assert.equal(r.status, 401);
    assert.match(r.headers["www-authenticate"], /Bearer/);
  } finally {
    await g.db.close();
  }
});
test("MCP initialization, scoped discovery and strict inputs", async () => {
  const f = await setup(["workspace:read"]);
  try {
    const init = await f.rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "client", version: "1" },
    });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.serverInfo.name, "chancery");
    const list = await f.rpc("tools/list");
    assert.deepEqual(
      list.body.result.tools.map((t: any) => t.name),
      ["get_office"],
    );
    const read = await f.call("get_office");
    assert.equal(read.body.result.structuredContent.result.id, f.office.id);
    const denied = await f.call("prepare_ai_request", {});
    assert(denied.body.error || denied.body.result?.isError);
    const extra = await f.call("get_office", { officeId: "other" });
    assert(extra.body.error || extra.body.result?.isError);
    assert.equal(f.calls(), 0);
  } finally {
    await f.db.close();
  }
});
test("MCP tokens are one-time, hashed, scoped to one Office, expiring and revocable", async () => {
  const f = await setup();
  try {
    const [stored] = await f.db.query(
      "SELECT * FROM mcp_connections WHERE id=$1",
      [f.created.body.id],
    );
    assert.equal(stored.token_hash, hash(f.token));
    assert(!JSON.stringify(stored).includes(f.token));
    const list = await f.user.agent.get(f.base + "/connections");
    assert(!JSON.stringify(list.body).includes(f.token));
    assert(!JSON.stringify(list.body).includes(stored.token_hash));
    const second = await f.makeOffice(f.user.account, "100", 2);
    const cross = await f.user.agent
      .delete("/api/offices/" + second.id + "/mcp/connections/" + stored.id)
      .set("Origin", f.cfg.origin)
      .set("X-CSRF-Token", f.user.csrf);
    assert.equal(cross.status, 404);
    const revoked = await f.user.agent
      .delete(f.base + "/connections/" + stored.id)
      .set("Origin", f.cfg.origin)
      .set("X-CSRF-Token", f.user.csrf);
    assert.equal(revoked.status, 200);
    assert.equal((await f.rpc("tools/list")).status, 401);
    const token2 = await f.post("/connections", {
      name: "Expiry",
      scopes: ["workspace:read"],
    });
    await f.db.office(f.office.id, (q) =>
      q.query(
        "UPDATE mcp_connections SET expires_at=now()-interval '1 second' WHERE id=$1",
        [token2.body.id],
      ),
    );
    assert.equal(
      (await f.rpc("tools/list", {}, token2.body.token)).status,
      401,
    );
  } finally {
    await f.db.close();
  }
});
test("MCP transport rejects foreign origins, hosts, URL credentials, batches and oversized bodies", async () => {
  const f = await setup();
  try {
    const base = () =>
      supertest(f.app)
        .post("/mcp")
        .set("Authorization", "Bearer " + f.token)
        .set("Host", "localhost:5180");
    assert.equal(
      (await base().set("Origin", "https://evil.invalid").send({})).status,
      403,
    );
    assert.equal(
      (await base().set("Host", "evil.invalid").send({})).status,
      403,
    );
    assert.equal(
      (
        await supertest(f.app)
          .post("/mcp?token=" + f.token)
          .set("Host", "localhost:5180")
          .send({})
      ).status,
      400,
    );
    assert.equal(
      (await base().send({ padding: "x".repeat(40000) })).status,
      413,
    );
    const batch = await base()
      .set("Accept", "application/json, text/event-stream")
      .send([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    assert.equal(batch.status, 400);
    assert.equal(
      (
        await supertest(f.app)
          .get("/mcp")
          .set("Host", "localhost:5180")
          .set("Authorization", "Bearer " + f.token)
      ).status,
      405,
    );
  } finally {
    await f.db.close();
  }
});
test("MCP prepares idempotent encrypted requests; only human session plus CSRF can approve exact quoted work", async () => {
  const f = await setup();
  try {
    const args = {
      clientRequestId: "request-123456789",
      model: "test-model",
      prompt: "Summarize our next steps.",
      maxTokens: 100,
    };
    const prepared = await f.call("prepare_ai_request", args);
    assert.equal(
      prepared.body.result?.isError,
      undefined,
      JSON.stringify(prepared.body),
    );
    const d = prepared.body.result.structuredContent.result;
    assert.equal(d.status, "pending");
    assert.equal(f.calls(), 0);
    const replay = await f.call("prepare_ai_request", args);
    assert.equal(replay.body.result.structuredContent.result.id, d.id);
    assert.equal(
      (await f.call("prepare_ai_request", { ...args, prompt: "Changed" })).body
        .result.isError,
      true,
    );
    const [row] = await f.db.office(f.office.id, (q) =>
      q.query("SELECT * FROM mcp_drafts WHERE id=$1", [d.id]),
    );
    assert(!row.request_enc.includes(args.prompt));
    const direct = await supertest(f.app)
      .post(f.base + "/requests/" + d.id + "/approve")
      .set("Origin", f.cfg.origin)
      .set("Authorization", "Bearer " + f.token)
      .send({ approved: true, quoteId: "fake" });
    assert.equal(direct.status, 401);
    const csrf = await f.user.agent
      .post(f.base + "/requests/" + d.id + "/approve")
      .set("Origin", f.cfg.origin)
      .send({ approved: true, quoteId: "fake" });
    assert.equal(csrf.status, 403);
    const q = await f.post("/requests/" + d.id + "/quote");
    assert.equal(q.status, 200, JSON.stringify(q.body));
    const out = await f.post("/requests/" + d.id + "/approve", {
      quoteId: q.body.id,
      approved: true,
    });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(f.calls(), 1);
    const again = await f.post("/requests/" + d.id + "/approve", {
      quoteId: q.body.id,
      approved: true,
    });
    assert.equal(again.status, 409);
    assert.equal(f.calls(), 1);
    const result = await f.call("get_ai_request", { id: d.id });
    assert.equal(
      result.body.result.structuredContent.result.result.content,
      "Working answer",
    );
    const logs = await f.db.office(f.office.id, (q) =>
      q.query("SELECT * FROM audit_events WHERE action LIKE 'mcp.%'"),
    );
    assert(logs.some((x: any) => x.action === "mcp.request_approved"));
    assert(!JSON.stringify(logs).includes(args.prompt));
    assert(!JSON.stringify(logs).includes(f.token));
  } finally {
    await f.db.close();
  }
});
test("MCP own conversations and connection-bound results cannot leak across accounts or connections", async () => {
  const f = await setup(["conversations:read", "requests:prepare"]);
  try {
    const other = await f.login(MEMBER);
    const secret = await f.conversations.create(
      { ...f.office.access, account: other.account },
      { title: "Private to another member" },
    );
    const read = await f.call("read_conversation", { id: secret.id });
    assert.equal(read.body.result.isError, true);
    const prepared = await f.call("prepare_ai_request", {
      clientRequestId: "request-abcdefgh",
      model: "test-model",
      prompt: "A brief",
    });
    const id = prepared.body.result.structuredContent.result.id;
    const second = await f.post("/connections", {
      name: "Other client",
      scopes: ["requests:prepare"],
    });
    assert.equal(
      (await f.call("get_ai_request", { id }, second.body.token)).body.result
        .isError,
      true,
    );
    const foreign = await other.agent.get(f.base + "/requests");
    assert.equal(foreign.status, 403);
  } finally {
    await f.db.close();
  }
});
test("MCP creation requires recent sign-in, CSRF, bounded expiry and valid scopes", async () => {
  const f = await setup();
  try {
    assert.equal(
      (await f.post("/connections", { name: "Bad", scopes: ["admin"] })).status,
      400,
    );
    assert.equal(
      (
        await f.post("/connections", {
          name: "Bad",
          scopes: ["workspace:read"],
          expiresInDays: 365,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.user.agent
          .post(f.base + "/connections")
          .set("Origin", f.cfg.origin)
          .send({ name: "Bad", scopes: ["workspace:read"] })
      ).status,
      403,
    );
    await f.db.query(
      "UPDATE auth_sessions SET authenticated_at=now()-interval '11 minutes' WHERE account_id=$1",
      [f.user.account.id],
    );
    assert.equal(
      (
        await f.post("/connections", {
          name: "Old",
          scopes: ["workspace:read"],
        })
      ).status,
      403,
    );
    f.office.snapshot.owners = [];
    assert.equal((await f.rpc("tools/list")).status, 403);
  } finally {
    await f.db.close();
  }
});
test("Revocation cancels queued work and failed quotes never execute", async () => {
  const f = await setup();
  try {
    const prep = await f.call("prepare_ai_request", {
      clientRequestId: "request-revoke-123",
      model: "test-model",
      prompt: "Prepare a brief",
    });
    const id = prep.body.result.structuredContent.result.id;
    const failed = await f.post("/requests/" + id + "/approve", {
      quoteId: "not-a-valid-quote",
      approved: true,
    });
    assert.equal(failed.status, 409);
    assert.equal(f.calls(), 0);
    await f.user.agent
      .delete(f.base + "/connections/" + f.created.body.id)
      .set("Origin", f.cfg.origin)
      .set("X-CSRF-Token", f.user.csrf);
    assert.equal((await f.post("/requests/" + id + "/quote")).status, 409);
    assert.equal(f.calls(), 0);
  } finally {
    await f.db.close();
  }
});

test("Official MCP clients connect over HTTP and the local stdio bridge", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  );
  const f = await setup(["workspace:read"]);
  const listener = f.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const port = (listener.address() as any).port;
  f.cfg.origin = "http://127.0.0.1:" + port;
  const url = new URL(f.cfg.origin + "/mcp");
  const remote = new Client({ name: "http-verifier", version: "1" });
  const local = new Client({ name: "stdio-verifier", version: "1" });
  try {
    await remote.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: "Bearer " + f.token } },
      }),
    );
    assert.deepEqual(
      (await remote.listTools()).tools.map((t) => t.name),
      ["get_office"],
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "scripts/mcp-bridge.ts"],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (x): x is [string, string] => typeof x[1] === "string",
          ),
        ),
        CHANCERY_MCP_URL: url.href,
        CHANCERY_MCP_TOKEN: f.token,
      },
      stderr: "pipe",
    });
    await local.connect(transport);
    assert.equal((await local.listTools()).tools[0].name, "get_office");
    const result = await local.callTool({ name: "get_office", arguments: {} });
    assert.equal((result.structuredContent as any).result.id, f.office.id);
  } finally {
    await local.close();
    await remote.close();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await f.db.close();
  }
});
test("MCP distributed limits block requests before tools run", async () => {
  const f = await setup();
  try {
    await f.db.query(
      "INSERT INTO mcp_rate_limits(key,count,expires_at) VALUES($1,120,now()+interval '1 minute') ON CONFLICT(key) DO UPDATE SET count=120,expires_at=excluded.expires_at",
      [hash("connection:" + f.created.body.id)],
    );
    const response = await f.rpc("tools/list");
    assert.equal(response.status, 429);
    assert.equal(response.headers["retry-after"], "60");
    assert.equal(f.calls(), 0);
  } finally {
    await f.db.close();
  }
});

test("MCP concurrent approval is single-use and cannot substitute another quote", async () => {
  const f = await setup();
  try {
    const prep = await f.call("prepare_ai_request", {
      clientRequestId: "concurrent-request-1",
      model: "test-model",
      prompt: "Original exact prompt",
    });
    const id = prep.body.result.structuredContent.result.id;
    const wrong = await f.ledger.quote(f.office.access, {
      model: "test-model",
      messages: [{ role: "user", content: "Different work" }],
      maxTokens: 1024,
      lane: "standard",
    });
    const denied = await f.post("/requests/" + id + "/approve", {
      quoteId: wrong.id,
      approved: true,
    });
    assert.equal(denied.status, 409);
    assert.equal(f.calls(), 0);
    const quote = await f.post("/requests/" + id + "/quote");
    const results = await Promise.all([
      f.post("/requests/" + id + "/approve", {
        quoteId: quote.body.id,
        approved: true,
      }),
      f.post("/requests/" + id + "/approve", {
        quoteId: quote.body.id,
        approved: true,
      }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(f.calls(), 1);
  } finally {
    await f.db.close();
  }
});
test("MCP encrypted drafts and credentials respect database Office isolation", async () => {
  const f = await setup();
  try {
    const other = await f.makeOffice(f.user.account, "100", 2);
    const prepared = await f.call("prepare_ai_request", {
      clientRequestId: "isolation-request-1",
      model: "test-model",
      prompt: "Office private context",
    });
    const id = prepared.body.result.structuredContent.result.id;
    assert.equal(
      (
        await f.db.office(other.id, (q) =>
          q.query("SELECT id FROM mcp_drafts WHERE id=$1", [id]),
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await f.db.office(other.id, (q) =>
          q.query("SELECT id FROM mcp_connections WHERE id=$1", [
            f.created.body.id,
          ]),
        )
      ).length,
      0,
    );
    assert.equal((await f.db.query("SELECT * FROM mcp_drafts")).length, 0);
    const denied = await f.user.agent
      .post("/api/offices/" + other.id + "/mcp/requests/" + id + "/quote")
      .set("Origin", f.cfg.origin)
      .set("X-CSRF-Token", f.user.csrf)
      .send({});
    assert.equal(denied.status, 404);
  } finally {
    await f.db.close();
  }
});

test("Interrupted human approval can be reviewed again without replaying executed work", async () => {
  const f = await setup();
  try {
    const prepared = await f.call("prepare_ai_request", {
      clientRequestId: "recovery-request-123",
      model: "test-model",
      prompt: "Recover this exact work",
    });
    const id = prepared.body.result.structuredContent.result.id;
    await f.db.office(f.office.id, (q) =>
      q.query(
        "UPDATE mcp_drafts SET status='submitted',approved_at=now()-interval '1 minute' WHERE id=$1",
        [id],
      ),
    );
    const list = await f.user.agent.get(f.base + "/requests");
    assert.equal(list.body[0].status, "retryable");
    const quote = await f.post("/requests/" + id + "/quote");
    assert.equal(quote.status, 200);
    assert.equal(
      (
        await f.post("/requests/" + id + "/approve", {
          quoteId: quote.body.id,
          approved: true,
        })
      ).status,
      200,
    );
    await f.db.office(f.office.id, (q) =>
      q.query(
        "UPDATE mcp_drafts SET approved_at=now()-interval '1 minute' WHERE id=$1",
        [id],
      ),
    );
    assert.equal((await f.post("/requests/" + id + "/quote")).status, 409);
    assert.equal(f.calls(), 1);
  } finally {
    await f.db.close();
  }
});

test("Connection credentials cannot be included in AI prompts or connection names", async () => {
  const f = await setup();
  try {
    const { checkGuards } = await import("../shared/guards.ts");
    assert.equal(checkGuards(f.token)?.kind, "api_key");
    assert.equal(
      checkGuards("ch_mcp_" + "x".repeat(42) + "-")?.kind,
      "api_key",
    );
    const response = await f.call("prepare_ai_request", {
      clientRequestId: "secret-request-123",
      model: "test-model",
      prompt: "Use this key: " + f.token,
    });
    assert.equal(response.body.result.isError, true);
    assert(!JSON.stringify(response.body).includes(f.token));
    assert.equal(f.calls(), 0);
    assert.equal(
      (
        await f.post("/connections", {
          name: f.token,
          scopes: ["workspace:read"],
        })
      ).status,
      400,
    );
    await assert.rejects(
      f.ledger.quote(f.office.access, {
        model: "test-model",
        messages: [{ role: "user", content: f.token }],
        maxTokens: 100,
        lane: "standard",
      }),
      (e: any) => e.code === "secret_detected",
    );
  } finally {
    await f.db.close();
  }
});
