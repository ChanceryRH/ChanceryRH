import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, chat } from "./fixture.ts";
import { uid, envelopeLeaf, MerkleTree } from "../server/crypto.ts";
import { ProviderFailure } from "../server/provider.ts";
import { dollars } from "../shared/money.ts";
import { createJobs } from "../server/jobs.ts";
test("billing: exact quote, signed receipt, replay and content binding", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const user = await r.login(),
    o = await r.office(user.account),
    quote = await r.ledger.quote(o.access, chat),
    id = uid("req_");
  const first = await r.ledger.request(o.access, {
    id,
    quoteId: quote.id,
    chat,
  });
  assert.equal(first.status, "complete");
  assert.equal(first.chargedUsd, "0.0105");
  assert.equal(r.calls(), 1);
  assert(await r.crypto.verify(first.receipt));
  const second = await r.ledger.request(o.access, {
    id,
    quoteId: quote.id,
    chat,
  });
  assert.equal(second.content, "Working answer");
  assert.equal(r.calls(), 1);
  await assert.rejects(
    r.ledger.request(o.access, {
      id,
      quoteId: quote.id,
      chat: { ...chat, maxTokens: 99 },
    }),
    { code: "idempotency_conflict" },
  );
  const tampered = structuredClone(first.receipt);
  tampered.payload.chargedUsd = "99";
  assert.equal(await r.crypto.verify(tampered), false);
  const tree = new MerkleTree([envelopeLeaf(first.receipt)]);
  assert(
    MerkleTree.verify(envelopeLeaf(first.receipt), tree.proof(0), tree.root),
  );
});
test("billing: concurrent holds cannot exceed shared Office cap", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const user = await r.login(),
    o = await r.office(user.account, "0.15");
  r.setCost(null);
  const quotes = await Promise.all([
    r.ledger.quote(o.access, chat),
    r.ledger.quote(o.access, chat),
  ]);
  const results = await Promise.allSettled(
    quotes.map((q) =>
      r.ledger.request(o.access, { id: uid("req_"), quoteId: q.id, chat }),
    ),
  );
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(r.calls(), 1);
  const rejected = results.find(
    (x) => x.status === "rejected",
  ) as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "actor_cap");
  const [row] = await r.db.office(o.id, (q) =>
    q.query("SELECT * FROM requests"),
  );
  assert.equal(row.status, "uncertain");
  assert.equal(row.reserved_pico, dollars("0.105").toString());
});
test("billing: missing cost and network failures retain holds; explicit refusal releases", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const user = await r.login(),
    o = await r.office(user.account);
  for (const [error, status] of [
    [new ProviderFailure("provider_network_uncertain", true), "uncertain"],
    [new ProviderFailure("provider_http_429", false), "refused"],
  ] as const) {
    r.fail(error);
    const quote = await r.ledger.quote(o.access, chat),
      result = await r.ledger.request(o.access, {
        id: uid("req_"),
        quoteId: quote.id,
        chat,
      });
    assert.equal(result.status, status);
    assert(await r.crypto.verify(result.receipt));
  }
});





