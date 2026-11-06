import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.ts";
import { ZERO } from "../shared/chain.ts";
const call = {
  to: "0x0000000000000000000000000000000000000008" as const,
  data: "0x" as const,
};
test("Proposal recovery: identical pending transfers cannot become separate payout records", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const u = await r.login(),
    o = await r.office(u.account);
  await r.offices.propose(o.access, "safe_draft", [call], {});
  await assert.rejects(r.offices.propose(o.access, "safe_draft", [call], {}), {
    code: "proposal_duplicate",
  });
});
test("Proposal recovery: executed proposals reconcile without preparing a second transfer", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const u = await r.login(),
    o = await r.office(u.account);
  const p = await r.offices.propose(o.access, "safe_draft", [call], {});
  (r.chain as any).findSafeExecution = async () => ZERO;
  r.chain.confirmedSafeTransaction = async () => true;
  const result = await r.offices.refreshProposal(o.access, p.id);
  assert.equal(result.status, "confirmed");
  assert.equal(
    (await r.db.office(o.id, (q) => q.query("SELECT * FROM office_proposals")))
      .length,
    1,
  );
});
test("Proposal recovery: a nonce collision never silently replays old calls", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const u = await r.login(),
    o = await r.office(u.account);
  const p = await r.offices.propose(o.access, "safe_draft", [call], {});
  (r.chain as any).findSafeExecution = async () => null;
  await assert.rejects(r.offices.refreshProposal(o.access, p.id), {
    code: "proposal_rebuild_required",
  });
  assert.equal(
    (await r.db.office(o.id, (q) => q.query("SELECT * FROM office_proposals")))
      .length,
    1,
  );
});

test("Proposal recovery: legacy duplicate executions cannot confirm twice and lookup errors do not replay", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const u = await r.login(),
    o = await r.office(u.account);
  const first = await r.offices.propose(o.access, "safe_draft", [call], {});
  await r.db.office(o.id, (q) =>
    q.query("UPDATE office_proposals SET status='superseded' WHERE id=$1", [
      first.id,
    ]),
  );
  const second = await r.offices.propose(o.access, "safe_draft", [call], {});
  r.chain.findSafeExecution = async () => {
    throw Error("RPC unavailable");
  };
  await assert.rejects(
    r.offices.refreshProposal(o.access, second.id),
    /RPC unavailable/,
  );
  r.chain.confirmedSafeTransaction = async () => true;
  await r.offices.confirm(o.access, first.id, ZERO);
  await assert.rejects(r.offices.confirm(o.access, second.id, ZERO), {
    code: "execution_already_claimed",
  });
  const rows = await r.db.office(o.id, (q) =>
    q.query("SELECT * FROM office_proposals WHERE status='confirmed'"),
  );
  assert.equal(rows.length, 1);
});

test("Safe confirmation: relayed success requires the matching Safe event and a later block", async () => {
  const { createChain } = await import("../server/chain.ts");
  const { config } = await import("../server/config.ts");
  const { encodeEventTopics, encodeAbiParameters } = await import("viem");
  const { safeAbi } = await import("../shared/chain.ts");
  const chain = createChain(config({})),
    safe = call.to;
  const event = {
    address: safe,
    data: encodeAbiParameters([{ type: "uint256" }], [0n]),
    topics: encodeEventTopics({
      abi: safeAbi,
      eventName: "ExecutionSuccess",
      args: { txHash: ZERO },
    }),
  };
  let block = 11n;
  const receipt: any = {
    status: "success",
    blockNumber: 10n,
    to: "0x0000000000000000000000000000000000000009",
    logs: [event],
  };
  chain.client.getTransactionReceipt = async () => receipt;
  chain.client.getBlockNumber = async () => block;
  assert.equal(await chain.confirmedSafeTransaction(ZERO, safe, ZERO), true);
  block = 10n;
  assert.equal(await chain.confirmedSafeTransaction(ZERO, safe, ZERO), false);
  block = 11n;
  receipt.logs = [{ ...event, address: receipt.to }];
  assert.equal(await chain.confirmedSafeTransaction(ZERO, safe, ZERO), false);
  receipt.logs = [event];
  receipt.status = "reverted";
  assert.equal(await chain.confirmedSafeTransaction(ZERO, safe, ZERO), false);
});
