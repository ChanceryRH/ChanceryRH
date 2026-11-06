import test from "node:test";
import assert from "node:assert/strict";
import supertest from "supertest";
import { createHash, randomBytes } from "node:crypto";
import { fixture, MEMBER } from "./fixture.ts";
import { dollars } from "../shared/money.ts";
const scopes = ["workspace:read", "requests:prepare", "ledger:read"];
async function setup() {
  const f = await fixture("mcp"),
    user = await f.login(),
    office = await f.office(user.account),
    base = "/api/offices/" + office.id + "/mcp";
  const post = (path: string, body: any = {}) =>
    user.agent
      .post(base + path)
      .set("Origin", f.cfg.origin)
      .set("X-CSRF-Token", user.csrf)
      .send(body);
  const c = await post("/connections", { name: "Research agent", scopes });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const call = (name: string, args: any = {}, token = c.body.token) =>
    supertest(f.app)
      .post("/mcp")
      .set("Host", "localhost:5180")
      .set("Authorization", "Bearer " + token)
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      });
  const prepare = async (id: string) => {
    const r = await call("prepare_ai_request", {
      clientRequestId: id,
      model: "test-model",
      prompt: "Summarize the plan",
      maxTokens: 100,
    });
    assert(!r.body.result?.isError, JSON.stringify(r.body));
    return r.body.result.structuredContent.result;
  };
  const approve = async (id: string) => {
    const q = await post("/requests/" + id + "/quote");
    assert.equal(q.status, 200, JSON.stringify(q.body));
    return post("/requests/" + id + "/approve", {
      quoteId: q.body.id,
      approved: true,
    });
  };
  return { ...f, user, office, base, post, c, call, prepare, approve };
}
test("Agents: rolling and per-request budgets reject excess before execution; concurrent approvals reserve atomically", async () => {
  const f = await setup();
  try {
    f.setCost(null);
    assert.equal(
      (
        await f.post("/connections/" + f.c.body.id + "/budget", {
          budgetUsd: "0.15",
          maxRequestUsd: "0.15",
        })
      ).status,
      200,
    );
    const one = await f.prepare("agent-request-0001"),
      two = await f.prepare("agent-request-0002");
    const quotes = await Promise.all(
      [one, two].map((d) => f.post("/requests/" + d.id + "/quote")),
    );
    const results = await Promise.all(
      [one, two].map((d, i) =>
        f.post("/requests/" + d.id + "/approve", {
          quoteId: quotes[i].body.id,
          approved: true,
        }),
      ),
    );
    // Unknown billing holds the full maximum, so concurrent work cannot use that same budget.
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 402).length, 1);
    assert.equal(f.calls(), 1);
    const list = await f.user.agent.get(f.base + "/connections");
    assert(list.body[0].usedUsd);
    assert.equal(
      (
        await f.post("/connections/" + f.c.body.id + "/budget", {
          budgetUsd: "0.01",
          maxRequestUsd: "0.01",
        })
      ).status,
      200,
    );
    const three = await f.prepare("agent-request-0003");
    assert.equal((await f.approve(three.id)).status, 402);
    assert.equal(
      (
        await f.post("/connections/" + f.c.body.id + "/budget", {
          budgetUsd: "-1",
          maxRequestUsd: "1",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.post("/connections/" + f.c.body.id + "/budget", {
          budgetUsd: "1",
          maxRequestUsd: "2",
        })
      ).status,
      400,
    );
  } finally {
    await f.db.close();
  }
});
test("Agents: unresolved reservations survive the rolling window; final older charges expire", async () => {
  const f = await setup();
  try {
    f.setCost(null);
    const one = await f.prepare("held-request-0001");
    assert.equal((await f.approve(one.id)).status, 200);
    await f.db.office(f.office.id, (q) =>
      q.query(
        "UPDATE requests SET created_at=now()-interval '2 days' WHERE id=$1",
        [one.id],
      ),
    );
    assert.equal(
      (
        await f.post("/connections/" + f.c.body.id + "/budget", {
          budgetUsd: "0.15",
          maxRequestUsd: "0.15",
        })
      ).status,
      200,
    );
    const two = await f.prepare("held-request-0002");
    assert.equal((await f.approve(two.id)).status, 402);
    assert.equal(f.calls(), 1);
  } finally {
    await f.db.close();
  }
});
test("Agents: pause blocks tools and approval, resume preserves pending work, revoke-all is permanent and Office scoped", async () => {
  const f = await setup();
  try {
    const draft = await f.prepare("pause-request-0001");
    assert.match(draft.reviewUrl, /agents\?office=.*&request=/);
    assert.equal(
      (
        await f.post("/connections/" + f.c.body.id + "/control", {
          action: "pause",
        })
      ).status,
      200,
    );
    assert.equal((await f.call("get_office")).status, 401);
    assert.equal(
      (await f.post("/requests/" + draft.id + "/quote")).status,
      403,
    );
    assert.equal(
      (
        await f.post("/connections/" + f.c.body.id + "/control", {
          action: "resume",
        })
      ).status,
      200,
    );
    assert.equal((await f.call("get_office")).status, 200);
    assert.equal((await f.post("/connections/revoke-all")).body.revoked, 1);
    assert.equal((await f.call("get_office")).status, 401);
    assert.equal(
      (
        await f.post("/connections/" + f.c.body.id + "/control", {
          action: "resume",
        })
      ).status,
      409,
    );
    const [row] = await f.db.office(f.office.id, (q) =>
      q.query("SELECT status FROM mcp_drafts WHERE id=$1", [draft.id]),
    );
    assert.equal(row.status, "rejected");
  } finally {
    await f.db.close();
  }
});
test("Agents: activity excludes prompts, includes receipts, and rejects a foreign Office", async () => {
  const f = await setup();
  try {
    const d = await f.prepare("activity-request-0001");
    assert.equal((await f.approve(d.id)).status, 200);
    const r = await f.user.agent.get(
      f.base + "/connections/" + f.c.body.id + "/activity",
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.items[0].id, d.id);
    assert(r.body.items[0].receipt_id);
    assert(!JSON.stringify(r.body).includes("Summarize the plan"));
    const receipt = await f.user.agent.get(
      "/api/offices/" +
        f.office.id +
        "/ledger/" +
        r.body.items[0].receipt_id +
        "/proof",
    );
    assert.equal(receipt.status, 200);
    const stranger = await f.login(MEMBER);
    assert.equal(
      (
        await stranger.agent.get(
          f.base + "/connections/" + f.c.body.id + "/activity",
        )
      ).status,
      403,
    );
  } finally {
    await f.db.close();
  }
});
async function oauthStart(f: Awaited<ReturnType<typeof setup>>) {
  const send = (url: string, body: any) =>
    supertest(f.app).post(url).set("Host", "localhost:5180").send(body);
  const registered = await send("/oauth/register", {
    client_name: "Desktop Agent",
    redirect_uris: ["https://agent.example/callback"],
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const verifier = randomBytes(32).toString("base64url"),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = {
    client_id: registered.body.client_id,
    redirect_uri: "https://agent.example/callback",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: f.cfg.origin + "/mcp",
    scope: scopes.join(" "),
    state: "request-state",
  };
  const started = await supertest(f.app)
    .get("/oauth/authorize")
    .set("Host", "localhost:5180")
    .query(params);
  assert.equal(started.status, 303, JSON.stringify(started.body));
  const id = new URLSearchParams(
    new URL(started.headers.location).hash.split("?")[1],
  ).get("connect");
  return { send, params, verifier, id };
}
test("OAuth: discovery, explicit consent, PKCE, audience, one-use codes, rotation and replay revocation", async () => {
  const f = await setup();
  try {
    const meta = await supertest(f.app)
      .get("/.well-known/oauth-protected-resource/mcp")
      .set("Host", "localhost:5180");
    assert.equal(meta.body.resource, f.cfg.origin + "/mcp");
    const o = await oauthStart(f);
    assert.equal(
      (await f.user.agent.get(f.base + "/oauth/" + o.id)).status,
      200,
    );
    assert.equal(
      (
        await supertest(f.app)
          .post(f.base + "/oauth/" + o.id + "/consent")
          .set("Origin", f.cfg.origin)
          .send({ approved: true })
      ).status,
      401,
    );
    const consent = await f.post("/oauth/" + o.id + "/consent", {
      approved: true,
      scopes,
      expiresInDays: 7,
      budgetUsd: "25",
      maxRequestUsd: "1",
    });
    assert.equal(consent.status, 200, JSON.stringify(consent.body));
    const url = new URL(consent.body.redirectUri);
    assert.equal(url.origin, "https://agent.example");
    assert.equal(url.searchParams.get("state"), "request-state");
    assert.equal(url.searchParams.get("iss"), f.cfg.origin);
    const exchange = {
      grant_type: "authorization_code",
      client_id: o.params.client_id,
      resource: o.params.resource,
      redirect_uri: o.params.redirect_uri,
      code: url.searchParams.get("code"),
      code_verifier: o.verifier,
    };
    assert.equal(
      (
        await o.send("/oauth/token", {
          ...exchange,
          resource: "https://evil.example/mcp",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await o.send("/oauth/token", {
          ...exchange,
          code_verifier: "x".repeat(43),
        })
      ).status,
      400,
    );
    const tokens = await o.send("/oauth/token", exchange);
    assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
    assert.equal(tokens.body.expires_in, 900);
    assert.equal(
      (await f.call("get_office", {}, tokens.body.access_token)).status,
      200,
    );
    assert.equal((await o.send("/oauth/token", exchange)).status, 400);
    const refresh = {
      grant_type: "refresh_token",
      client_id: o.params.client_id,
      resource: o.params.resource,
      refresh_token: tokens.body.refresh_token,
    };
    const rotated = await o.send("/oauth/token", refresh);
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    assert.equal(
      (await f.call("get_office", {}, tokens.body.access_token)).status,
      401,
    );
    assert.equal(
      (await f.call("get_office", {}, rotated.body.access_token)).status,
      200,
    );
    assert.equal((await o.send("/oauth/token", refresh)).status, 400);
    assert.equal(
      (await f.call("get_office", {}, rotated.body.access_token)).status,
      401,
    );
  } finally {
    await f.db.close();
  }
});
test("OAuth: refuses unsafe redirects, unknown clients, scope escalation and consent replay", async () => {
  const f = await setup();
  try {
    const o = await oauthStart(f);
    assert.equal(
      (
        await o.send("/oauth/register", {
          client_name: "Bad",
          redirect_uris: ["javascript:alert(1)"],
        })
      ).status,
      400,
    );
    const bad = await supertest(f.app)
      .get("/oauth/authorize")
      .set("Host", "localhost:5180")
      .query({ ...o.params, redirect_uri: "https://evil.example" });
    assert.equal(bad.status, 400);
    assert(!bad.headers.location);
    assert.equal(
      (
        await f.post("/oauth/" + o.id + "/consent", {
          approved: true,
          scopes: ["clerks:read"],
          expiresInDays: 7,
          budgetUsd: "25",
          maxRequestUsd: "1",
        })
      ).status,
      400,
    );
    const deny = {
      approved: false,
      scopes,
      expiresInDays: 7,
      budgetUsd: "25",
      maxRequestUsd: "1",
    };
    const denied = await f.post("/oauth/" + o.id + "/consent", deny);
    assert.equal(denied.status, 200);
    assert.equal(
      new URL(denied.body.redirectUri).searchParams.get("error"),
      "access_denied",
    );
    assert.equal(
      (await f.post("/oauth/" + o.id + "/consent", deny)).status,
      404,
    );
  } finally {
    await f.db.close();
  }
});

test("OAuth: official SDK discovers, registers, requests consent and exchanges a code", async () => {
  const f = await setup();
  let server: any;
  try {
    server = f.app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    f.cfg.origin = "http://127.0.0.1:" + server.address().port;
    const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
    let client: any,
      tokens: any,
      verifier = "",
      url: URL | undefined;
    const provider = {
      redirectUrl: "https://agent.example/callback",
      clientMetadata: {
        client_name: "SDK agent",
        redirect_uris: ["https://agent.example/callback"],
        token_endpoint_auth_method: "none" as const,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      clientInformation: () => client,
      saveClientInformation: (v: any) => {
        client = v;
      },
      tokens: () => tokens,
      saveTokens: (v: any) => {
        tokens = v;
      },
      saveCodeVerifier: (v: string) => {
        verifier = v;
      },
      codeVerifier: () => verifier,
      redirectToAuthorization: (v: URL) => {
        url = v;
      },
    };
    assert.equal(
      await auth(provider, {
        serverUrl: f.cfg.origin + "/mcp",
        scope: "workspace:read",
      }),
      "REDIRECT",
    );
    assert(url);
    const started = await fetch(url, { redirect: "manual" });
    assert.equal(started.status, 303);
    const id = new URLSearchParams(
      new URL(started.headers.get("location")!).hash.split("?")[1],
    ).get("connect");
    const consent = await f.post("/oauth/" + id + "/consent", {
      approved: true,
      scopes: ["workspace:read"],
      expiresInDays: 7,
      budgetUsd: "25",
      maxRequestUsd: "1",
    });
    assert.equal(consent.status, 200, JSON.stringify(consent.body));
    const code = new URL(consent.body.redirectUri).searchParams.get("code")!;
    assert.equal(
      await auth(provider, {
        serverUrl: f.cfg.origin + "/mcp",
        authorizationCode: code,
      }),
      "AUTHORIZED",
    );
    assert(tokens.access_token);
    assert(tokens.refresh_token);
  } finally {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await f.db.close();
  }
});

test("Agents: every active member can connect; visibility and revoke-all stay within ownership", async () => {
  const f = await setup();
  try {
    const { seatLeaf } = await import("../server/chain.ts"),
      { MerkleTree } = await import("../server/crypto.ts");
    const member = await f.login(MEMBER),
      leaf = seatLeaf(
        member.account.credential,
        "member",
        dollars("10").toString(),
        null,
      );
    await f.db.office(f.office.id, async (q) => {
      await q.query(
        "INSERT INTO seats(id,office_id,account_id,credential,role,monthly_cap_pico,status,leaf) VALUES('seat_agent_member',$1,$2,$3,'member',$4,'active',$5)",
        [
          f.office.id,
          member.account.id,
          member.account.credential,
          dollars("10").toString(),
          leaf,
        ],
      );
      const rows = await q.query(
        "SELECT leaf FROM seats WHERE status='active'",
      );
      const root = new MerkleTree(rows.map((r) => r.leaf)).root;
      await q.query("UPDATE seats SET approved_root=$1", [root]);
      f.office.snapshot.seatRoot = root;
    });
    await f.db.query("UPDATE offices SET seat_root=$1 WHERE id=$2", [
      f.office.snapshot.seatRoot,
      f.office.id,
    ]);
    await f.db.query(
      "INSERT INTO office_access(office_id,account_id) VALUES($1,$2)",
      [f.office.id, member.account.id],
    );
    const post = (path: string, b: any = {}) =>
      member.agent
        .post(f.base + path)
        .set("Origin", f.cfg.origin)
        .set("X-CSRF-Token", member.csrf)
        .send(b);
    const made = await post("/connections", {
      name: "Member agent",
      scopes: ["workspace:read"],
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const list = await member.agent.get(f.base + "/connections");
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, made.body.id);
    assert.equal(
      (
        await post("/connections/" + f.c.body.id + "/control", {
          action: "pause",
        })
      ).status,
      404,
    );
    assert.equal((await post("/connections/revoke-all")).body.revoked, 1);
    assert.equal((await f.call("get_office")).status, 200);
  } finally {
    await f.db.close();
  }
});
