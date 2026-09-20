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







