import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, encodeAbiParameters, type Hex, type Address } from "viem";
import { fixture, chat } from "./fixture.ts";
import { createJobs } from "../server/jobs.ts";
import { waiveExpiredReceipt } from "../server/reconcile.ts";
import { expiredCollectionProof, type CollectionReader } from "../server/collection.ts";
import type { DeploymentBuild } from "../server/deployment.ts";
import { uid } from "../server/crypto.ts";
import { ZERO } from "../shared/chain.ts";

test("Collection recovery: expired usage and seat fees can be waived without rewriting signed history", async t => {
  const r = await fixture(); t.after(() => r.db.close());
  const user = await r.login(), o = await r.office(user.account);
  const quote = await r.ledger.quote(o.access, chat);
  const first = await r.ledger.request(o.access, {id: uid("req_"), quoteId: quote.id, chat});
  assert.equal(first.status, "complete");
  const [original] = await r.db.office(o.id, q => q.query("SELECT * FROM receipts WHERE request_id=$1", [first.id]));
  await r.db.office(o.id, q => q.query("DELETE FROM seat_charges"));
  await createJobs(r).seatFees(o.access.office);
  const [fee] = await r.db.office(o.id, q => q.query("SELECT * FROM receipts WHERE kind='seat_fee'"));
  assert(fee && BigInt(fee.charged_pico) > 0n);
  const oldPeriod = o.snapshot.periodStart;
  r.chain.expiredCollectionProof = async (office, period, batch) => {
    assert.equal(office, o.id); assert.equal(period, oldPeriod); assert.equal(batch, undefined);
    return {blockNumber: "123", blockHash: ZERO, periodStart: oldPeriod + 43200};
  };
  o.snapshot.periodStart += 43200; o.snapshot.allowancePeriod = o.snapshot.periodStart;
  const nextQuote = await r.ledger.quote(o.access, chat);
  await assert.rejects(r.ledger.request(o.access, {id: uid("req_"), quoteId: nextQuote.id, chat}), {code: "previous_period_unsettled"});
  for (const receipt of [original, fee]) {
    const result = await waiveExpiredReceipt(r, {officeId: o.id, receiptId: receipt.id, evidenceHash: "ab".repeat(32)});
    assert(await r.crypto.verify(result.envelope));
    assert.equal(result.envelope.payload.amends, receipt.id);
    assert.equal(result.envelope.payload.chargedUsd, "0");
    const [retained] = await r.db.office(o.id, q => q.query("SELECT * FROM receipts WHERE id=$1", [receipt.id]));
    assert.equal(retained.status, "waived"); assert.deepEqual(retained.envelope, receipt.envelope);
    assert.equal(retained.leaf, receipt.leaf); assert.equal(retained.charged_pico, receipt.charged_pico);
    await assert.rejects(waiveExpiredReceipt(r, {officeId: o.id, receiptId: receipt.id, evidenceHash: "ab".repeat(32)}), {code: "receipt_not_collectible"});
  }
  const next = await r.ledger.quote(o.access, chat);
  assert.equal((await r.ledger.request(o.access, {id: uid("req_"), quoteId: next.id, chat})).status, "complete");
  const status = await r.ledger.status(o.access, first.id); assert.equal(status.chargedUsd, "0");
});

test("Collection recovery: batched charges require finalized nonpayment; failures leave accounting unchanged", async t => {
  const r = await fixture(); t.after(() => r.db.close());
  const user = await r.login(), o = await r.office(user.account), other = await r.office(user.account, "100", 2);
  const quote = await r.ledger.quote(o.access, chat);
  const first = await r.ledger.request(o.access, {id: uid("req_"), quoteId: quote.id, chat});
  const [receipt] = await r.db.office(o.id, q => q.query("SELECT * FROM receipts WHERE request_id=$1", [first.id]));
  const input = {officeId: o.id, receiptId: receipt.id, evidenceHash: "ab".repeat(32)};
  const batchId = `0x${"12".repeat(32)}` as Hex;
  await r.db.office(o.id, async q => {
    await q.query("INSERT INTO settlements(id,office_id,actor_id,delegate,day,period_start,amount_usdg,receipt_root,receipt_ids,receipt_count) VALUES($1,$2,$3,$4,1,$5,10500,$6,$7,1)",
      [batchId,o.id,ZERO,o.snapshot.delegate,o.snapshot.periodStart,ZERO,JSON.stringify([receipt.id])]);
    await q.query("UPDATE receipts SET settlement_id=$1 WHERE id=$2", [batchId,receipt.id]);
  });
  let called = 0;
  r.chain.expiredCollectionProof = async () => {called++; throw Error("finality unavailable");};
  await assert.rejects(waiveExpiredReceipt(r, {...input, officeId: other.id}), {code: "receipt_not_collectible"});
  assert.equal(called, 0);
  await assert.rejects(waiveExpiredReceipt(r, input), /finality unavailable/);
  assert.equal((await r.db.office(o.id, q => q.query("SELECT status FROM receipts WHERE id=$1", [receipt.id])))[0].status, "final");
  await r.db.office(o.id, q => q.query("UPDATE settlements SET status='confirmed' WHERE id=$1", [batchId]));
  await assert.rejects(waiveExpiredReceipt(r, input), {code: "collection_already_paid"});
  await r.db.office(o.id, q => q.query("UPDATE settlements SET status='prepared' WHERE id=$1", [batchId]));
  // A signed outbox entry is preserved; finality proves the obsolete-period debit cannot succeed.
  await r.db.query("INSERT INTO transaction_outbox(id,office_id,kind,reference,transaction_hash,raw_enc) VALUES('recovery_test_tx',$1,'settlement',$2,$3,'test-only-placeholder')", [o.id,batchId,ZERO]);
  r.chain.expiredCollectionProof = async (office, period, batch) => {
    assert.equal(office,o.id);assert.equal(period,o.snapshot.periodStart);assert.deepEqual(batch,{id:batchId,actorId:ZERO});
    return {blockNumber: "123", blockHash: ZERO, periodStart: period+43200};
  };
  await waiveExpiredReceipt(r,input);
  const [outbox] = await r.db.query("SELECT status,raw_enc FROM transaction_outbox WHERE id='recovery_test_tx'");
  assert.equal(outbox.status,"prepared");assert.equal(outbox.raw_enc,"test-only-placeholder");
});

test("Collection proof: expiry and nonpayment use a finalized block and verified contract code", async () => {
  const address = (n:number) => `0x${n.toString(16).padStart(40,"0")}` as Address;
  const registry=address(1), log=address(2), office=`0x${"03".repeat(32)}` as Hex;
  const batch={id:`0x${"04".repeat(32)}` as Hex,actorId:ZERO};
  const artifact={deployedBytecode:"0x6001" as Hex,immutableReferences:{},sourceSha256:"a".repeat(64)};
  const build={registry:artifact,log:artifact} as DeploymentBuild;
  function reader() {
    const seen:bigint[]=[];
    const r:CollectionReader={getChainId:async()=>4663,getBlock:async args=>{
      assert.equal(args.blockTag,"finalized");return {number:100n,hash:ZERO};
    },getCode:async args=>{seen.push(args.blockNumber);return "0x6001";},
    readContract:async args=>{
      seen.push(args.blockNumber);
      if(args.functionName==="offices")return [address(8)];
      if(args.functionName==="budget")return [100n,0n,44200];
      if(args.functionName==="settlementLog")return log;
      if(args.functionName==="registry")return registry;
      if(args.functionName==="recorded") {
        assert.deepEqual(args.args,[keccak256(encodeAbiParameters([{type:"bytes32"},{type:"bytes32"},{type:"bytes32"}],[office,ZERO,batch.id]))]);return false;
      }
      throw Error("unexpected read");
    }};return {r,seen};
  }
  const good=reader();assert.equal((await expiredCollectionProof(good.r,registry,office,1000,batch,build)).blockNumber,"100");
  assert(good.seen.length>=6 && good.seen.every(n=>n===100n));
  for(const [method,value] of [["budget",[100n,0n,1000]],["offices",[address(0)]],["registry",address(9)],["recorded",true],["recorded",undefined]] as const) {
    const f=reader(),read=f.r.readContract;f.r.readContract=async args=>args.functionName===method?value:read(args);
    await assert.rejects(expiredCollectionProof(f.r,registry,office,1000,batch,build));
  }
  const badCode=reader();badCode.r.getCode=async()=>"0x6002";
  await assert.rejects(expiredCollectionProof(badCode.r,registry,office,1000,batch,build),{code:"collection_code_mismatch"});
  const unavailable=reader();unavailable.r.getBlock=async()=>{throw Error("no finalized block");};
  await assert.rejects(expiredCollectionProof(unavailable.r,registry,office,1000,batch,build),/no finalized block/);
  const wrongChain=reader();wrongChain.r.getChainId=async()=>1;
  await assert.rejects(expiredCollectionProof(wrongChain.r,registry,office,1000,batch,build),{code:"chain_mismatch"});
});
