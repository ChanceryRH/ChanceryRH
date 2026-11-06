import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { fixture, MEMBER } from "./fixture.ts";
import { releasedUpdates } from "../shared/releases.ts";
import { MerkleTree } from "../server/crypto.ts";
import { seatLeaf } from "../server/chain.ts";
import { policyHash, policySchema } from "../server/offices.ts";
import { ProviderFailure } from "../server/provider.ts";
import { dollars } from "../shared/money.ts";
import { createSideBySide } from "../server/features/side-by-side.ts";

const question = "Which three tasks should our team finish first this week?";
type Runtime = Awaited<ReturnType<typeof fixture>>;
type User = Awaited<ReturnType<Runtime["login"]>>;
function client(r: Runtime, user: User, officeId: string) {
  const base = `/api/offices/${officeId}`;
  return {
    get: (path: string) => user.agent.get(base + path),
    post: (path: string, body: unknown = {}) =>
      user.agent
        .post(base + path)
        .set("Origin", r.cfg.origin)
        .set("X-CSRF-Token", user.csrf)
        .send(body as object),
    delete: (path: string) =>
      user.agent
        .delete(base + path)
        .set("Origin", r.cfg.origin)
        .set("X-CSRF-Token", user.csrf),
  };
}
async function setup(released = "side_by_side", cap = "100") {
  const r = await fixture(released),
    user = await r.login(),
    o = await r.office(user.account, cap);
  return { r, user, o, api: client(r, user, o.id) };
}
async function compare(
  api: ReturnType<typeof client>,
  models: string[],
  prompt = question,
) {
  const priced = await api.post("/comparisons/quotes", { prompt, models });
  assert.equal(priced.status, 200, JSON.stringify(priced.body));
  const created = await api.post("/comparisons", {
    prompt,
    models,
    quoteIds: priced.body.models.map((m: any) => m.quote.id),
    approvedMaximumUsd: priced.body.totalMaximumUsd,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return { priced: priced.body, created: created.body };
}
// Columns run in parallel, as the page does. Called in-process: supertest's per-request
// servers reset connections under parallel load. Single-column HTTP runs are covered below.
async function runAll(
  r: Runtime,
  access: any,
  id: string,
  count: number,
  from = 0,
) {
  const compare = createSideBySide(r);
  return Promise.all(
    Array.from({ length: count - from }, (_, n) => n + from).map(async (i) => ({
      status: 200,
      body: JSON.parse(JSON.stringify(await compare.run(access, id, i))),
    })),
  );
}

test("Side by Side is a known update", () => {
  assert.ok(releasedUpdates("side_by_side").has("side_by_side"));
});

test("Side by Side: every route is hidden while the update is off", async (t) => {
  const { r, api } = await setup("");
  t.after(() => r.db.close());
  const id = `comparison_${"a".repeat(32)}`;
  for (const response of [
    await api.post("/comparisons/quotes", {
      prompt: question,
      models: ["a", "b"],
    }),
    await api.post("/comparisons", {}),
    await api.get("/comparisons"),
    await api.get(`/comparisons/${id}`),
    await api.post(`/comparisons/${id}/columns/0/run`),
    await api.post(`/comparisons/${id}/favourite`, { requestId: null }),
    await api.delete(`/comparisons/${id}`),
  ]) {
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "update_unavailable");
  }
  assert.equal(r.calls(), 0);
});

test("Side by Side: guests are refused, models follow the Office policy, and 2–3 models are required", async (t) => {
  const { r, o, api } = await setup();
  t.after(() => r.db.close());
  // Add a guest seat for a second account and have the Safe approve the new seat root.
  const guest = await r.login(MEMBER),
    cap = dollars("5").toString(),
    leaf = seatLeaf(guest.account.credential, "guest", cap, null);
  await r.db.office(o.id, async (q) => {
    await q.query(
      "INSERT INTO seats(id,office_id,account_id,credential,role,monthly_cap_pico,status,leaf) VALUES('seat_guest_sample',$1,$2,$3,'guest',$4,'active',$5)",
      [o.id, guest.account.id, guest.account.credential, cap, leaf],
    );
    const seats = await q.query("SELECT credential,leaf FROM seats");
    const root = new MerkleTree(
      seats
        .sort((a, b) => (a.credential < b.credential ? -1 : 1))
        .map((s) => s.leaf as Hex),
    ).root;
    await q.query("UPDATE seats SET approved_root=$1", [root]);
    r.snapshots.get(o.id)!.seatRoot = root;
  });
  const visitor = client(r, guest, o.id);
  assert.equal((await visitor.get("")).status, 200);
  for (const response of [
    await visitor.post("/comparisons/quotes", {
      prompt: question,
      models: ["model-a", "model-b"],
    }),
    await visitor.get("/comparisons"),
  ]) {
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "role_required");
  }

  for (const [models, code] of [
    [["model-a"], "model_count"],
    [["model-a", "model-b", "model-c", "model-d"], "model_count"],
    [["model-a", "model-a"], "model_duplicate"],
  ] as const) {
    const response = await api.post("/comparisons/quotes", {
      prompt: question,
      models,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, code);
  }

  // Restrict the Office to two models, in the database and onchain.
  const policy = policySchema.parse({
    maxRequestUsd: "2",
    allowedModels: ["model-a", "model-b"],
  });
  await r.db.query("UPDATE offices SET policy=$1,policy_hash=$2 WHERE id=$3", [
    JSON.stringify(policy),
    policyHash(policy),
    o.id,
  ]);
  r.snapshots.get(o.id)!.policyHash = policyHash(policy);
  const blocked = await api.post("/comparisons/quotes", {
    prompt: question,
    models: ["model-a", "model-c"],
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, "model_policy");
  const [{ count }] = await r.db.office(o.id, (q) =>
    q.query("SELECT count(*)::int AS count FROM quotes"),
  );
  assert.equal(count, 0, "nothing is quoted when one model is not allowed");
  const allowed = await api.post("/comparisons/quotes", {
    prompt: question,
    models: ["model-a", "model-b"],
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.ready, true);

  const secret = await api.post("/comparisons/quotes", {
    prompt: "Use sk-abcdefghijklmnopqrstuvwxyz for this",
    models: ["model-a", "model-b"],
  });
  assert.equal(secret.status, 400);
  assert.equal(secret.body.error.code, "secret_detected");
  assert.equal(r.calls(), 0);
});

test("Side by Side: one approval runs every model, with one signed receipt each, saved encrypted", async (t) => {
  const { r, o, api } = await setup();
  t.after(() => r.db.close());
  const models = ["model-a", "model-b", "model-c"];
  const priced = await api.post("/comparisons/quotes", {
    prompt: question,
    models,
  });
  assert.equal(priced.body.ready, true);
  assert.equal(priced.body.totalMaximumUsd, "0.315");
  assert.deepEqual(
    priced.body.models.map((m: any) => m.quote.maximumUsd),
    ["0.105", "0.105", "0.105"],
  );
  const quoteIds = priced.body.models.map((m: any) => m.quote.id);
  const tooLow = await api.post("/comparisons", {
    prompt: question,
    models,
    quoteIds,
    approvedMaximumUsd: "0.2",
  });
  assert.equal(tooLow.status, 409);
  assert.equal(tooLow.body.error.code, "approval_too_low");
  const created = await api.post("/comparisons", {
    prompt: question,
    models,
    quoteIds,
    approvedMaximumUsd: "0.315",
  });
  assert.equal(created.status, 200);
  assert.deepEqual(
    created.body.columns.map((c: any) => c.state),
    ["waiting", "waiting", "waiting"],
  );
  assert.equal(r.calls(), 0, "nothing runs until the columns are started");

  const results = await runAll(r, o.access, created.body.id, 3);
  for (const [i, response] of results.entries()) {
    assert.equal(response.status, 200);
    const column = response.body;
    assert.equal(column.model, models[i]);
    assert.equal(column.state, "complete");
    assert.equal(column.content, "Working answer");
    assert.equal(column.chargedUsd, "0.0105");
    assert.deepEqual(column.tokens, { input: 12, output: 5 });
    assert.equal(typeof column.durationMs, "number");
    assert.equal(column.receipt.payload.requestId, column.requestId);
    assert(await r.crypto.verify(column.receipt));
  }
  assert.equal(r.calls(), 3);
  const requestIds = results.map((x) => x.body.requestId);
  const receipts = await r.db.office(o.id, (q) =>
    q.query("SELECT * FROM receipts WHERE request_id=ANY($1::text[])", [
      requestIds,
    ]),
  );
  assert.equal(receipts.length, 3);
  assert.equal(new Set(receipts.map((x) => x.id)).size, 3);

  // Running a column again reports it; it is never sent or billed twice.
  const again = await api.post(`/comparisons/${created.body.id}/columns/1/run`);
  assert.equal(again.body.state, "complete");
  assert.equal(r.calls(), 3);
  // The quotes were consumed, so they cannot fund another comparison.
  const reused = await api.post("/comparisons", {
    prompt: question,
    models,
    quoteIds,
    approvedMaximumUsd: "0.315",
  });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error.code, "quote_invalid");

  const favourite = await api.post(
    `/comparisons/${created.body.id}/favourite`,
    { requestId: requestIds[2] },
  );
  assert.equal(favourite.status, 200);
  const bad = await api.post(`/comparisons/${created.body.id}/favourite`, {
    requestId: "req_not_in_this_comparison",
  });
  assert.equal(bad.status, 400);
  const list = await api.get("/comparisons");
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].title, question);
  assert.equal(list.body[0].favourite, "model-c");
  assert.deepEqual(list.body[0].models, models);
  const reopened = await api.get(`/comparisons/${created.body.id}`);
  assert.equal(reopened.body.prompt, question);
  assert.equal(reopened.body.favourite, requestIds[2]);
  assert.deepEqual(
    reopened.body.columns.map((c: any) => [c.state, c.content, c.receiptId]),
    results.map((x) => ["complete", "Working answer", x.body.receiptId]),
  );

  const [row] = await r.db.office(o.id, (q) =>
    q.query("SELECT * FROM comparisons"),
  );
  assert(!JSON.stringify(row).includes("three tasks"));
  assert(!JSON.stringify(row).includes(requestIds[0]));

  const removed = await api.delete(`/comparisons/${created.body.id}`);
  assert.equal(removed.status, 200);
  assert.equal((await api.get("/comparisons")).body.length, 0);
  assert.equal((await api.get(`/comparisons/${created.body.id}`)).status, 404);
  const kept = await r.db.office(o.id, (q) =>
    q.query("SELECT * FROM receipts WHERE request_id=ANY($1::text[])", [
      requestIds,
    ]),
  );
  assert.equal(kept.length, 3, "billing receipts are retained");
});

test("Side by Side: one failing column does not break the others", async (t) => {
  const { r, o, api } = await setup();
  t.after(() => r.db.close());
  const complete = r.provider.complete;
  r.provider.complete = async (input, ...rest) => {
    if (input.model === "model-b")
      throw new ProviderFailure("provider_http_429", false);
    return complete(input, ...rest);
  };
  const models = ["model-a", "model-b", "model-c"],
    { created } = await compare(api, models);
  // The third column's quote lapses before it starts.
  await r.db.office(o.id, (q) =>
    q.query(
      "UPDATE quotes SET expires_at=now()-interval '1 minute' WHERE envelope->'payload'->>'model'='model-c'",
    ),
  );
  const results = [
    await api.post(`/comparisons/${created.id}/columns/0/run`),
    ...(await runAll(r, o.access, created.id, 3, 1)),
  ];
  assert(results.every((x) => x.status === 200));
  const [a, b, c] = results.map((x) => x.body);
  assert.equal(a.state, "complete");
  assert.equal(a.content, "Working answer");
  assert.equal(b.state, "refused");
  assert.equal(b.chargedUsd, "0");
  assert.equal(b.error.code, "provider_http_429");
  assert(await r.crypto.verify(b.receipt), "a refusal still gets a receipt");
  assert.equal(c.state, "blocked");
  assert.equal(c.error.code, "quote_invalid");
  assert.equal(c.receipt, null);
  const reopened = await api.get(`/comparisons/${created.id}`);
  assert.deepEqual(
    reopened.body.columns.map((x: any) => x.state),
    ["complete", "refused", "blocked"],
  );
  const receipts = await r.db.office(o.id, (q) =>
    q.query("SELECT * FROM receipts WHERE kind='usage'"),
  );
  assert.equal(receipts.length, 2);
});

test("Side by Side: a combined price that breaks a budget is explained before anything runs", async (t) => {
  const { r, api } = await setup("side_by_side", "0.15");
  t.after(() => r.db.close());
  const models = ["model-a", "model-b"],
    priced = await api.post("/comparisons/quotes", {
      prompt: question,
      models,
    });
  assert.equal(priced.status, 200);
  assert.equal(priced.body.totalMaximumUsd, "0.21");
  assert.equal(priced.body.ready, false);
  assert.equal(priced.body.problem.code, "actor_cap");
  const created = await api.post("/comparisons", {
    prompt: question,
    models,
    quoteIds: priced.body.models.map((m: any) => m.quote.id),
    approvedMaximumUsd: priced.body.totalMaximumUsd,
  });
  assert.equal(created.status, 402);
  assert.equal(created.body.error.code, "actor_cap");
  assert.equal((await api.get("/comparisons")).body.length, 0);
  assert.equal(r.calls(), 0);
});
