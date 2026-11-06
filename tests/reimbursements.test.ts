import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fixture, MEMBER, OWNER } from "./fixture.ts";
import { simulateChain, TESTER } from "./ui-chain.ts";
import { releasedUpdates } from "../shared/releases.ts";
import { ADDRESSES } from "../shared/chain.ts";
import { dollars } from "../shared/money.ts";
import { uid, MerkleTree } from "../server/crypto.ts";
import { seatLeaf, typedSafeMessage } from "../server/chain.ts";
import { safeTypedTypes } from "../shared/safe-signing.ts";
import { createReimbursements } from "../server/features/reimbursements.ts";
const OFFICER = privateKeyToAccount(`0x${"44".repeat(32)}`),
  GUEST = privateKeyToAccount(`0x${"55".repeat(32)}`);
const transferAbi = parseAbi([
  "function transfer(address to,uint256 amount) returns(bool)",
]);
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]).toString("base64")}`;
const today = new Date().toISOString().slice(0, 10);
const request = (overrides: Record<string, unknown> = {}) => ({
  amount: "12.5",
  vendor: "Sample Vendor",
  spentOn: today,
  category: "Software",
  note: "Team plan for the demo-account",
  ...overrides,
});
type Runtime = Awaited<ReturnType<typeof fixture>>;
/** Adds an approved seat and moves the simulated Safe seat root to include it. */
async function seat(r: Runtime, officeId: string, account: any, role: string) {
  const cap = dollars("50").toString();
  await r.db.office(officeId, (q) =>
    q.query(
      "INSERT INTO seats(id,office_id,account_id,credential,role,monthly_cap_pico,status,leaf) VALUES($1,$2,$3,$4,$5,$6,'active',$7)",
      [
        uid("seat_"),
        officeId,
        account.id,
        account.credential,
        role,
        cap,
        seatLeaf(account.credential, role, cap, null),
      ],
    ),
  );
  const seats = await r.db.office(officeId, (q) =>
    q.query("SELECT * FROM seats WHERE status='active' AND revoked_at IS NULL"),
  );
  const root = new MerkleTree(
    [...seats]
      .sort((a, b) =>
        a.credential < b.credential ? -1 : a.credential > b.credential ? 1 : 0,
      )
      .map((s) => s.leaf as Hex),
  ).root;
  await r.db.office(officeId, (q) =>
    q.query("UPDATE seats SET approved_root=$1 WHERE status='active'", [root]),
  );
  r.snapshots.get(officeId)!.seatRoot = root;
  return r.offices.access(account, officeId);
}
async function setup(released = "reimbursements") {
  const r = await fixture(released);
  const owner = await r.login(OWNER),
    member = await r.login(MEMBER),
    officer = await r.login(OFFICER as any),
    guest = await r.login(GUEST as any),
    o = await r.office(owner.account);
  const [passkeyAccount] = await r.db.query(
    "INSERT INTO accounts(id,wallet,credential,handle) VALUES($1,NULL,$2,$3) RETURNING *",
    [uid("account_"), "passkey:sample-user", "sample-user"],
  );
  const access = {
    principal: await r.offices.access(owner.account, o.id),
    member: await seat(r, o.id, member.account, "member"),
    officer: await seat(r, o.id, officer.account, "officer"),
    guest: await seat(r, o.id, guest.account, "guest"),
    passkey: await seat(r, o.id, passkeyAccount, "member"),
  };
  const simulated: { to: string; data: Hex }[] = [];
  let simulationPasses = true;
  (r.chain as any).simulateCall = async (_safe: string, call: any) => {
    simulated.push(call);
    return { success: simulationPasses, method: "eth_call", limitations: [] };
  };
  return {
    r,
    o,
    owner,
    member,
    officer,
    access,
    simulated,
    failSimulation: () => (simulationPasses = false),
    reimbursements: createReimbursements(r),
  };
}
test("Reimbursements is a known update", () => {
  assert.ok(releasedUpdates("reimbursements").has("reimbursements"));
});
test("Reimbursements: every route is hidden until the update is released", async (t) => {
  const off = await fixture("");
  t.after(() => off.db.close());
  const owner = await off.login(OWNER),
    o = await off.office(owner.account);
  const routes: [string, string][] = [
    ["get", ""],
    ["post", ""],
    ["post", "/approve"],
    ["get", "/reimb_x/receipt"],
    ["post", "/reimb_x/reject"],
    ["post", "/reimb_x/withdraw"],
  ];
  for (const [method, path] of routes) {
    const res = await (owner.agent as any)
      [method](`/api/offices/${o.id}/reimbursements${path}`)
      .set("Origin", off.cfg.origin)
      .set("X-CSRF-Token", owner.csrf)
      .send(method === "post" ? {} : undefined);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(res.body.error.code, "update_unavailable");
  }
  const on = await setup();
  t.after(() => on.r.db.close());
  const listed = await on.owner.agent.get(
    `/api/offices/${on.o.id}/reimbursements`,
  );
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.canReview, true);
  const created = await on.member.agent
    .post(`/api/offices/${on.o.id}/reimbursements`)
    .set("Origin", on.r.cfg.origin)
    .set("X-CSRF-Token", on.member.csrf)
    .send(request({ receipt: JPEG }));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.amount, "12.5");
});
test("Reimbursements: guests are refused, members need a verified wallet and valid amounts", async (t) => {
  const s = await setup();
  t.after(() => s.r.db.close());
  const { reimbursements: rb, access } = s;
  await assert.rejects(rb.list(access.guest), { code: "role_required" });
  await assert.rejects(rb.submit(access.guest, request()), {
    code: "role_required",
  });
  await assert.rejects(rb.submit(access.passkey, request()), {
    code: "wallet_required",
  });
  for (const amount of ["0", "-1", "abc", "1.1234567", "60000", ""])
    await assert.rejects(
      rb.submit(access.member, request({ amount })),
      { code: "amount_invalid" },
      amount,
    );
  await assert.rejects(rb.submit(access.member, request({ amount: 5 })));
  await assert.rejects(rb.submit(access.member, request({ amount: "2000" })), {
    code: "insufficient_safe_balance",
  });
  await assert.rejects(
    rb.submit(access.member, request({ spentOn: "2999-01-01" })),
    { code: "date_invalid" },
  );
  await assert.rejects(
    rb.submit(access.member, request({ category: "Gifts" })),
  );
  await assert.rejects(
    rb.submit(
      access.member,
      request({ receipt: "data:image/png;base64,AAAA" }),
    ),
    { code: "receipt_invalid" },
  );
  await assert.rejects(
    rb.submit(access.member, request({ payoutWallet: `0x${"ab".repeat(20)}` })),
  );
  const created = await rb.submit(
    access.member,
    request({ amount: "0.000001", receipt: JPEG }),
  );
  assert.equal(created.amount, "0.000001");
  const [row] = await s.r.db.office(s.o.id, (q) =>
    q.query("SELECT * FROM reimbursements WHERE id=$1", [created.id]),
  );
  assert.equal(row.payout_wallet, MEMBER.address.toLowerCase());
  assert.equal(String(row.amount_units), "1");
  assert(!JSON.stringify(row).includes("Sample Vendor"));
  assert(!row.receipt_enc.includes(JPEG.slice(23)));
  assert.equal((await rb.receipt(access.member, created.id)).image, JPEG);
  assert.equal((await rb.receipt(access.officer, created.id)).image, JPEG);
  const mine = await rb.list(access.member);
  assert.equal(mine.review, null);
  assert.equal(mine.mine[0].vendor, "Sample Vendor");
  assert.equal(mine.mine[0].status, "submitted");
  // Another member cannot open someone else's receipt.
  const other = await s.r.login(
    privateKeyToAccount(`0x${"66".repeat(32)}`) as any,
  );
  const otherAccess = await seat(s.r, s.o.id, other.account, "member");
  await assert.rejects(rb.receipt(otherAccess, created.id), {
    code: "reimbursement_not_found",
  });
});
test("Reimbursements: members cannot approve; approval proposes a simulated USDG transfer", async (t) => {
  const s = await setup();
  t.after(() => s.r.db.close());
  const { reimbursements: rb, access } = s;
  const first = await rb.submit(access.member, request({ amount: "12.5" })),
    second = await rb.submit(access.member, request({ amount: "40" })),
    own = await rb.submit(access.officer, request({ amount: "3" }));
  await assert.rejects(rb.approve(access.member, { ids: [first.id] }), {
    code: "officer_required",
  });
  await assert.rejects(rb.reject(access.member, first.id, { reason: "No" }), {
    code: "officer_required",
  });
  await assert.rejects(rb.approve(access.officer, { ids: [own.id] }), {
    code: "self_approval",
  });
  await assert.rejects(rb.approve(access.officer, { ids: ["reimb_missing"] }), {
    code: "reimbursement_not_found",
  });
  // Officers may still not propose other Safe changes.
  await assert.rejects(s.r.offices.propose(access.officer, "policy", [], {}), {
    code: "principal_required",
  });
  const result = await rb.approve(access.officer, {
    ids: [first.id, second.id],
  });
  assert.equal(result.totalUsdg, "52.5");
  const [proposal] = await s.r.db.office(s.o.id, (q) =>
    q.query("SELECT * FROM office_proposals WHERE id=$1", [result.proposal.id]),
  );
  assert.equal(proposal.kind, "reimbursement");
  assert.equal(proposal.status, "pending");
  assert.deepEqual(proposal.payload.reimbursementIds, [first.id, second.id]);
  assert(!JSON.stringify(proposal.payload).includes("Sample Vendor"));
  const decoded = proposal.payload.calls.map((c: any) => {
    assert.equal(c.to, ADDRESSES.usdg);
    return decodeFunctionData({ abi: transferAbi, data: c.data }).args;
  });
  assert.deepEqual(decoded, [
    [MEMBER.address, 12_500_000n],
    [MEMBER.address, 40_000_000n],
  ]);
  assert.equal(s.simulated.length, 2);
  assert.deepEqual(
    s.simulated.map((c) => c.data),
    proposal.payload.calls.map((c: any) => c.data),
  );
  const listed = await rb.list(access.officer);
  assert.equal(listed.review!.awaitingTotal, "52.5");
  assert.equal(listed.review!.queue.length, 1);
  assert.equal(listed.availableBalance, "947.5");
  assert.deepEqual(
    (await rb.list(access.member)).mine.map((m) => m.status).sort(),
    ["approved", "approved"],
  );
  await assert.rejects(rb.approve(access.principal, { ids: [first.id] }), {
    code: "reimbursement_reviewed",
  });
  // Approved payouts count against the Safe balance (1,000 USDG in the fixture).
  const large = await rb.submit(access.member, request({ amount: "950" }));
  await assert.rejects(rb.approve(access.principal, { ids: [large.id] }), {
    code: "insufficient_safe_balance",
  });
  assert.equal(
    (await rb.list(access.member)).mine.find((m) => m.id === large.id)!.status,
    "submitted",
  );
  // A failed simulation leaves the request waiting for review.
  s.failSimulation();
  await assert.rejects(rb.approve(access.principal, { ids: [own.id] }), {
    code: "simulation_failed",
  });
  assert.equal(
    (await rb.list(access.officer)).mine.find((m) => m.id === own.id)!.status,
    "submitted",
  );
});
test("Reimbursements: reject with a reason, withdraw, and paid on Safe confirmation", async (t) => {
  const s = await setup();
  t.after(() => s.r.db.close());
  const { reimbursements: rb, access } = s;
  const rejected = await rb.submit(access.member, request()),
    withdrawn = await rb.submit(access.member, request()),
    paid = await rb.submit(access.member, request({ amount: "7.25" }));
  await assert.rejects(rb.reject(access.officer, rejected.id, { reason: "" }));
  await rb.reject(access.officer, rejected.id, {
    reason: "Duplicate of an earlier request.",
  });
  await assert.rejects(
    rb.reject(access.officer, rejected.id, { reason: "Again" }),
    { code: "reimbursement_reviewed" },
  );
  await assert.rejects(rb.approve(access.officer, { ids: [rejected.id] }), {
    code: "reimbursement_reviewed",
  });
  await assert.rejects(rb.withdraw(access.officer, withdrawn.id), {
    code: "reimbursement_reviewed",
  });
  await rb.withdraw(access.member, withdrawn.id);
  const { proposal } = await rb.approve(access.officer, { ids: [paid.id] });
  const txHash = `0x${"cd".repeat(32)}` as Hex;
  (s.r.chain as any).confirmedSafeTransaction = async () => true;
  await s.r.offices.confirm(access.principal, proposal.id, txHash);
  const mine = new Map(
    (await rb.list(access.member)).mine.map((m) => [m.id, m]),
  );
  assert.equal(mine.get(rejected.id)!.status, "rejected");
  assert.equal(
    mine.get(rejected.id)!.reason,
    "Duplicate of an earlier request.",
  );
  assert.equal(mine.get(withdrawn.id)!.status, "withdrawn");
  assert.equal(mine.get(paid.id)!.status, "paid");
  assert.equal(mine.get(paid.id)!.transactionHash, txHash);
  assert.equal(mine.get(paid.id)!.proposalId, proposal.id);
  const review = (await rb.list(access.officer)).review!;
  assert.equal(review.awaiting.length, 0);
  assert.deepEqual(review.recent.map((x) => x.status).sort(), [
    "paid",
    "rejected",
  ]);
});
test("Reimbursements: end to end on the simulated chain (sign, execute, confirm)", async (t) => {
  const r = await fixture("reimbursements");
  t.after(() => r.db.close());
  const { wallet } = simulateChain(r.chain, r.snapshots, r.cfg.registry as Hex);
  (r.chain as any).simulateCall = async (_safe: string, call: any) => {
    const { args } = decodeFunctionData({ abi: transferAbi, data: call.data });
    return { success: args[1] <= 1000n * 1000000n, method: "eth_call" };
  };
  const tester = (await r.login(TESTER as any)).account,
    safe = "0x5afe000000000000000000000000000000000002" as Hex;
  async function run(proposal: any, a: any) {
    const signature = await TESTER.signTypedData({
      domain: { chainId: 4663, verifyingContract: safe },
      types: safeTypedTypes,
      primaryType: "SafeTx",
      message: typedSafeMessage(proposal.transaction),
    });
    const ready = await r.offices.signProposal(a, proposal.id, signature);
    assert(ready.ready);
    const txHash = await wallet("eth_sendTransaction", [
      { from: TESTER.address, ...ready.execution },
    ]);
    return r.offices.confirm(a, proposal.id, txHash as Hex);
  }
  const opened = await r.offices.create(tester, {
    name: "Demo Office",
    safe,
    monthlyCap: "100",
  });
  await run(
    opened.proposal,
    await r.offices.access(tester, opened.officeId, undefined, true),
  );
  const a = await r.offices.access(tester, opened.officeId),
    rb = createReimbursements(r);
  const created = await rb.submit(a, request({ amount: "19.99" }));
  const { proposal } = await rb.approve(a, { ids: [created.id] });
  const confirmed = await run(proposal, a);
  assert.equal(confirmed.status, "confirmed");
  const [row] = (await rb.list(a)).mine;
  assert.equal(row.status, "paid");
  assert.equal(row.transactionHash, confirmed.txHash);
});

test("Reimbursements: a consumed nonce and proven nonpayment return the whole stale batch to review", async (t) => {
  const { r, o, member, access, reimbursements } = await setup();
  t.after(() => r.db.close());
  const item = await reimbursements.submit(access.member, request());
  const approved = await reimbursements.approve(access.officer, {
    ids: [item.id],
  });
  r.chain.safeNonceConsumed = async () => false;
  r.chain.findSafeExecution = async () => null;
  await assert.rejects(reimbursements.returnToReview(access.officer, item.id), {
    code: "proposal_still_executable",
  });
  r.chain.safeNonceConsumed = async () => true;
  r.chain.findSafeExecution = async () => `0x${"01".repeat(32)}`;
  await assert.rejects(reimbursements.returnToReview(access.officer, item.id), {
    code: "payout_already_executed",
  });
  r.chain.findSafeExecution = async () => {
    throw Error("history unavailable");
  };
  await assert.rejects(
    reimbursements.returnToReview(access.officer, item.id),
    /history unavailable/,
  );
  r.chain.findSafeExecution = async () => null;
  const result = await reimbursements.returnToReview(access.officer, item.id);
  assert.deepEqual(result.returned, [item.id]);
  const [row] = await r.db.office(o.id, (q) =>
    q.query("SELECT * FROM reimbursements WHERE id=$1", [item.id]),
  );
  assert.equal(row.status, "submitted");
  assert.equal(row.proposal_id, null);
  const p = await r.offices.proposal(access.principal, approved.proposal.id);
  assert.equal(p.status, "superseded");
});
