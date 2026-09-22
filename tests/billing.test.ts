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
test("billing: provider cost above quote is absorbed and zero-retention content is not saved", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const user = await r.login(),
    o = await r.office(user.account);
  r.setCost(dollars("3"));
  const input = { ...chat, lane: "zero_retention" as const },
    quote = await r.ledger.quote(o.access, input),
    id = uid("req_"),
    result = await r.ledger.request(o.access, {
      id,
      quoteId: quote.id,
      chat: input,
    });
  assert.equal(result.chargedUsd, quote.maximumUsd);
  assert.equal(result.content, "Working answer");
  const replay = await r.ledger.status(o.access, id);
  assert.equal(replay.content, null);
  const [row] = await r.db.office(o.id, (q) =>
    q.query("SELECT response_enc FROM requests WHERE id=$1", [id]),
  );
  assert.equal(row.response_enc, null);
});
test("billing: guards run before provider and seat fees are idempotent", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const user = await r.login(),
    o = await r.office(user.account);
  await assert.rejects(
    r.ledger.quote(o.access, {
      ...chat,
      messages: [
        { role: "user", content: "My secret sk-abcdefghijklmnopqrstuvwxyz" },
      ],
    }),
    { code: "secret_detected" },
  );
  assert.equal(r.calls(), 0);
  await r.db.office(o.id, (q) => q.query("DELETE FROM seat_charges"));
  const jobs = createJobs(r);
  await jobs.seatFees(o.access.office);
  await jobs.seatFees(o.access.office);
  const rows = await r.db.office(o.id, (q) =>
    q.query("SELECT * FROM receipts WHERE kind='seat_fee'"),
  );
  assert.equal(rows.length, 1);
  assert(await r.crypto.verify(rows[0].envelope));
});
test("conversations: encrypted history, deletion and ephemeral content", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const user = await r.login(),
    o = await r.office(user.account),
    conversation = await r.conversations.create(o.access, {
      title: "Private plan",
    }),
    input = { ...chat, conversationId: conversation.id };
  const quote = await r.ledger.quote(o.access, input),
    result = await r.ledger.request(o.access, {
      id: uid("req_"),
      quoteId: quote.id,
      chat: input,
    }),
    history = await r.conversations.messages(o.access, conversation.id);
  assert.deepEqual(
    history.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.equal(history[1].content, "Working answer");
  await r.conversations.remove(o.access, conversation.id);
  assert.equal((await r.ledger.status(o.access, result.id)).content, null);
  assert(await r.crypto.verify(result.receipt));
  const ephemeral = await r.conversations.create(o.access, { ephemeral: true }),
    privateInput = { ...chat, conversationId: ephemeral.id },
    q = await r.ledger.quote(o.access, privateInput),
    reply = await r.ledger.request(o.access, {
      id: uid("req_"),
      quoteId: q.id,
      chat: privateInput,
    });
  assert.equal(reply.content, "Working answer");
  assert.equal(
    (await r.conversations.messages(o.access, ephemeral.id)).length,
    0,
  );
  assert.equal((await r.ledger.status(o.access, reply.id)).content, null);
});


