import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, chat } from "./fixture.ts";
import { createJobs } from "../server/jobs.ts";
import { uid } from "../server/crypto.ts";
import { dollars } from "../shared/money.ts";
import { decodeFunctionData } from "viem";
import { allowanceAbi } from "../shared/chain.ts";
test("Settlement recovery: finalized revert retries the same batch with a new signed attempt and preserves history", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const u = await r.login(),
    o = await r.office(u.account),
    jobs = createJobs(r);
  let n = 0,
    finalized = false,
    success = false,
    broadcasts = 0;
  r.chain.prepareSubmission = async () =>
    ({
      hash: `0x${(++n).toString(16).padStart(64, "0")}`,
      raw: `0x${n.toString(16).padStart(2, "0")}`,
    }) as any;
  r.chain.broadcast = async () => {
    broadcasts++;
    return "0x" as any;
  };
  r.chain.receipt = async () =>
    ({ status: success ? "success" : "reverted", blockNumber: 98n }) as any;
  r.chain.failedSubmissionFinalized = async () => finalized;
  const q = await r.ledger.quote(o.access, chat);
  const request = await r.ledger.request(o.access, {
    id: uid("req_"),
    quoteId: q.id,
    chat,
  });
  await r.db.office(o.id, (q) =>
    q.query(
      "UPDATE receipts SET created_at=now()-interval '70 minutes' WHERE request_id=$1",
      [request.id],
    ),
  );
  await jobs.settle(o.access.office);
  await jobs.outbox();
  let [batch] = await r.db.office(o.id, (q) =>
    q.query("SELECT * FROM settlements"),
  );
  assert.equal(batch.status, "failed");
  await r.db.query(
    "UPDATE transaction_outbox SET confirmed_at=now()-interval '2 hours'",
  );
  await jobs.settle(o.access.office);
  assert.equal(n, 1);
  finalized = true;
  await r.db.query("UPDATE transaction_outbox SET attempt_count=5");
  await jobs.settle(o.access.office);
  assert.equal(n, 1, "retry budget is enforced");
  await r.db.query(
    "UPDATE transaction_outbox SET attempt_count=1,confirmed_at=now()",
  );
  await jobs.settle(o.access.office);
  assert.equal(n, 1, "retry backoff is enforced");
  await r.db.query(
    "UPDATE transaction_outbox SET confirmed_at=now()-interval '2 hours'",
  );
  await jobs.settle(o.access.office);
  assert.equal(n, 2);
  const [attempt] = await r.db.query("SELECT * FROM transaction_attempts");
  assert.equal(attempt.status, "failed");
  const [entry] = await r.db.query("SELECT * FROM transaction_outbox");
  assert.equal(entry.attempt_count, 2);
  assert.equal(entry.reference, batch.id);
  assert.equal(entry.status, "prepared");
  success = true;
  await jobs.outbox();
  [batch] = await r.db.office(o.id, (q) =>
    q.query("SELECT * FROM settlements"),
  );
  assert.equal(batch.status, "confirmed");
  const [receipt] = await r.db.office(o.id, (q) =>
    q.query("SELECT settlement_id FROM receipts WHERE request_id=$1", [
      request.id,
    ]),
  );
  assert.equal(receipt.settlement_id, batch.id);
  await jobs.settle(o.access.office);
  assert.equal(n, 2);
  assert.equal(broadcasts, 2);
});
test("Collection exposure: stale final charges and large unresolved holds block additional paid work", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const u = await r.login(),
    o = await r.office(u.account);
  let q = await r.ledger.quote(o.access, chat);
  await r.ledger.request(o.access, { id: uid("req_"), quoteId: q.id, chat });
  await r.db.office(o.id, (q) =>
    q.query("UPDATE receipts SET created_at=now()-interval '3 hours'"),
  );
  q = await r.ledger.quote(o.access, chat);
  await assert.rejects(
    r.ledger.request(o.access, { id: uid("req_"), quoteId: q.id, chat }),
    { code: "collection_overdue" },
  );
  await r.db.office(o.id, async (q) => {
    await q.query("UPDATE receipts SET created_at=now()");
    await q.query("UPDATE requests SET status='uncertain',reserved_pico=$1", [
      dollars("25").toString(),
    ]);
  });
  q = await r.ledger.quote(o.access, chat);
  await assert.rejects(
    r.ledger.request(o.access, { id: uid("req_"), quoteId: q.id, chat }),
    { code: "unsettled_limit" },
  );
  assert.equal(r.calls(), 1);
});
test("Allowance recovery: only a principal can propose alignment to the registry period", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const u = await r.login(),
    o = await r.office(u.account);
  await assert.rejects(
    r.offices.resyncAllowance({ ...o.access, role: "officer" }, {}),
    { code: "principal_required" },
  );
  o.snapshot.allowancePeriod -= 42;
  const p = await r.offices.resyncAllowance(o.access, {}),
    d = await r.offices.proposal(o.access, p.id);
  const call = d.payload.calls.at(-1),
    decoded = decodeFunctionData({ abi: allowanceAbi, data: call.data });
  assert.equal(decoded.functionName, "setAllowance");
  assert.equal(decoded.args?.[4], o.snapshot.periodStart);
});
test("Settlement recovery: delayed old receipt cannot overwrite a newer confirmed attempt", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const u = await r.login(),
    o = await r.office(u.account),
    jobs = createJobs(r);
  let n = 0;
  r.chain.prepareSubmission = async () =>
    ({
      hash: `0x${(++n).toString(16).padStart(64, "0")}`,
      raw: `0x${n.toString(16).padStart(2, "0")}`,
    }) as any;
  r.chain.broadcast = async () => "0x" as any;
  r.chain.failedSubmissionFinalized = async () => true;
  const quote = await r.ledger.quote(o.access, chat);
  await r.ledger.request(o.access, {
    id: uid("req_"),
    quoteId: quote.id,
    chat,
  });
  await r.db.office(o.id, (q) =>
    q.query("UPDATE receipts SET created_at=now()-interval '70 minutes'"),
  );
  await jobs.settle(o.access.office);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve)),
    reading = new Promise<void>((resolve) => (started = resolve));
  let reads = 0;
  r.chain.receipt = async () => {
    if (++reads === 1) {
      started();
      await gate;
    }
    return { status: "reverted", blockNumber: 98n } as any;
  };
  const delayed = jobs.outbox();
  await reading;
  await jobs.outbox();
  await r.db.query(
    "UPDATE transaction_outbox SET confirmed_at=now()-interval '2 hours'",
  );
  await jobs.settle(o.access.office);
  r.chain.receipt = async () =>
    ({ status: "success", blockNumber: 98n }) as any;
  await jobs.outbox();
  release();
  await delayed;
  const [entry] = await r.db.query("SELECT * FROM transaction_outbox");
  const [batch] = await r.db.office(o.id, (q) =>
    q.query("SELECT * FROM settlements"),
  );
  assert.equal(entry.status, "confirmed");
  assert.equal(batch.status, "confirmed");
  assert.equal(batch.tx_hash, entry.transaction_hash);
  assert.equal(entry.attempt_count, 2);
});
