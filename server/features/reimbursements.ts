import { z } from "zod";
import { encodeFunctionData, parseAbi, type Address } from "viem";
import { uid } from "../crypto.ts";
import { ApiError, assert } from "../errors.ts";
import { checkGuards } from "../../shared/guards.ts";
import { ADDRESSES } from "../../shared/chain.ts";
import {
  dollars,
  picoToUsdString,
  usdgToPico,
  PICO_PER_USDG_UNIT,
} from "../../shared/money.ts";
import type { Access } from "../offices.ts";
import type { Call } from "../chain.ts";
import type { FeatureContext } from "./index.ts";
// Reimbursements (RELEASED_UPDATES=reimbursements). Every route here must pass "reimbursements" as its gate.
export const CATEGORIES = [
  "Software",
  "Travel",
  "Services",
  "Supplies",
  "Meals",
  "Other",
] as const;
export const MAX_REQUEST_USDG = "50000";
/** Upper bound for a downscaled receipt sent as a data URL (about 520 KB of image). */
export const MAX_RECEIPT_CHARS = 700_000;
const MAX_OPEN_PER_MEMBER = 50;
const MAX_BATCH = 20;
const transferAbi = parseAbi([
  "function transfer(address to,uint256 amount) returns(bool)",
]);
/** USDG transfer from the Safe: the only call a reimbursement proposal contains. */
export function transferCall(to: Address, units: bigint): Call {
  return {
    to: ADDRESSES.usdg,
    data: encodeFunctionData({
      abi: transferAbi,
      functionName: "transfer",
      args: [to, units],
    }),
  };
}
const usdg = (units: bigint) => picoToUsdString(usdgToPico(units));
function amountUnits(value: unknown) {
  let pico: bigint;
  try {
    pico = dollars(value, MAX_REQUEST_USDG);
  } catch (e) {
    throw new ApiError(400, "amount_invalid", (e as Error).message);
  }
  assert(pico > 0n, 400, "amount_invalid", "Enter an amount above zero.");
  assert(
    pico % PICO_PER_USDG_UNIT === 0n,
    400,
    "amount_invalid",
    "USDG amounts can have at most 6 decimal places.",
  );
  return pico / PICO_PER_USDG_UNIT;
}
const IMAGE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
function receiptImage(value: string) {
  const m = IMAGE.exec(value);
  assert(
    m,
    400,
    "receipt_invalid",
    "Attach the receipt as a JPEG, PNG or WebP image.",
  );
  const head = Buffer.from(m[2].slice(0, 24), "base64"),
    valid =
      m[1] === "jpeg"
        ? head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
        : m[1] === "png"
          ? head.subarray(0, 4).toString("hex") === "89504e47"
          : head.subarray(0, 4).toString("latin1") === "RIFF" &&
            head.subarray(8, 12).toString("latin1") === "WEBP";
  assert(
    valid,
    400,
    "receipt_invalid",
    "The receipt file does not look like an image.",
  );
  return value;
}
function spentOn(value: string) {
  const day = new Date(`${value}T00:00:00Z`);
  assert(
    !Number.isNaN(day.getTime()) &&
      day.toISOString().slice(0, 10) === value &&
      day.getTime() <= Date.now() + 86400000 &&
      day.getUTCFullYear() >= 2000,
    400,
    "date_invalid",
    "Use the date on the receipt. It cannot be in the future.",
  );
  return value;
}
const ids = (values: string[]) => JSON.stringify(values);
const IN_IDS = "id IN (SELECT jsonb_array_elements_text($1::jsonb))";
const COLUMNS = "*, to_char(spent_on,'YYYY-MM-DD') AS spent_day";
export function createReimbursements(
  ctx: Pick<FeatureContext, "db" | "chain" | "crypto" | "offices">,
) {
  const { db, chain, crypto, offices } = ctx;
  const reviewer = (a: Access) => ["principal", "officer"].includes(a.role);
  function member(a: Access) {
    assert(
      a.role !== "guest",
      403,
      "role_required",
      "Guests cannot use Reimbursements.",
    );
  }
  function officer(a: Access) {
    member(a);
    assert(
      reviewer(a),
      403,
      "officer_required",
      "An Officer or Principal must review reimbursements.",
    );
  }
  function active(a: Access) {
    assert(
      a.snapshot?.active,
      409,
      "office_inactive",
      "The Office must be open onchain before reimbursements can be paid.",
    );
    return a.snapshot;
  }
  const balanceMessage = (balance: bigint) =>
    `The Safe holds ${usdg(balance)} USDG, which is not enough for this. Ask a Safe owner to add USDG first.`;
  async function handles(accountIds: string[]) {
    if (!accountIds.length) return new Map<string, string>();
    const rows = await db.query(
      "SELECT id,handle FROM accounts WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))",
      [ids([...new Set(accountIds)])],
    );
    return new Map(rows.map((r) => [r.id, r.handle]));
  }
  function view(a: Access, r: any, names: Map<string, string>) {
    const details = crypto.open(
      a.office.id,
      `reimbursement:${r.id}`,
      r.details_enc,
    );
    return {
      id: r.id,
      status: r.status,
      amount: usdg(BigInt(String(r.amount_units))),
      vendor: details.vendor,
      note: details.note,
      category: r.category,
      spentOn: r.spent_day,
      payoutWallet: r.payout_wallet,
      hasReceipt: !!r.receipt_enc,
      submittedBy: names.get(r.account_id) || "Member",
      mine: r.account_id === a.account.id,
      createdAt: r.created_at,
      reviewedAt: r.reviewed_at,
      reason: r.reason_enc
        ? crypto.open(a.office.id, `reimbursement-reason:${r.id}`, r.reason_enc)
        : null,
      proposalId: r.proposal_id,
      transactionHash: r.tx_hash,
      paidAt: r.paid_at,
    };
  }
  async function list(a: Access) {
    member(a);
    const isReviewer = reviewer(a);
    const { mine, others, held } = await db.office(a.office.id, async (q) => ({
      mine: await q.query(
        `SELECT ${COLUMNS} FROM reimbursements WHERE account_id=$1 ORDER BY created_at DESC LIMIT 200`,
        [a.account.id],
      ),
      others: isReviewer
        ? await q.query(
            `SELECT ${COLUMNS} FROM reimbursements WHERE status IN ('submitted','approved') OR (status IN ('paid','rejected') AND created_at > now() - interval '90 days') ORDER BY created_at DESC LIMIT 300`,
          )
        : [],
      held: (
        await q.query(
          "SELECT COALESCE(SUM(amount_units),0)::text AS held FROM reimbursements WHERE status='approved'",
        )
      )[0].held as string,
    }));
    const names = await handles(
      [...mine, ...others].map((r: any) => r.account_id),
    );
    const show = (rows: any[]) => rows.map((r) => view(a, r, names));
    const total = (rows: any[]) =>
      usdg(rows.reduce((t, r) => t + BigInt(String(r.amount_units)), 0n));
    const queue = others.filter((r: any) => r.status === "submitted").reverse();
    const awaiting = others.filter((r: any) => r.status === "approved");
    const balance = a.snapshot?.safeBalanceUnits ?? 0n;
    return {
      wallet: a.account.wallet,
      canSubmit: !!a.account.wallet && !!a.snapshot?.active,
      canReview: isReviewer,
      categories: CATEGORIES,
      maxAmount: MAX_REQUEST_USDG,
      safeBalance: usdg(balance),
      availableBalance: usdg(
        balance > BigInt(held) ? balance - BigInt(held) : 0n,
      ),
      mine: show(mine),
      review: isReviewer
        ? {
            queue: show(queue),
            queueTotal: total(queue),
            awaiting: show(awaiting),
            awaitingTotal: total(awaiting),
            recent: show(
              others.filter((r: any) =>
                ["paid", "rejected"].includes(r.status),
              ),
            ).slice(0, 50),
          }
        : null,
    };
  }
  async function submit(a: Access, body: unknown) {
    member(a);
    const snapshot = active(a);
    assert(
      a.account.wallet,
      409,
      "wallet_required",
      "Payouts go only to a verified wallet. Sign in to Chancery with your wallet instead of a passkey, then request your reimbursement.",
    );
    const input = z
      .strictObject({
        amount: z.string().max(40),
        vendor: z.string().trim().min(1).max(120),
        spentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        category: z.enum(CATEGORIES),
        note: z.string().trim().max(1000).default(""),
        receipt: z.string().max(MAX_RECEIPT_CHARS).optional(),
      })
      .parse(body);
    const units = amountUnits(input.amount),
      day = spentOn(input.spentOn),
      receipt = input.receipt ? receiptImage(input.receipt) : null,
      guard = checkGuards(input.vendor, input.note);
    assert(
      !guard,
      400,
      "secret_detected",
      guard?.message || "Secret detected.",
    );
    assert(
      units <= snapshot.safeBalanceUnits,
      422,
      "insufficient_safe_balance",
      balanceMessage(snapshot.safeBalanceUnits),
    );
    const id = uid("reimb_");
    await db.office(a.office.id, async (q) => {
      const [{ open }] = await q.query(
        "SELECT count(*)::int AS open FROM reimbursements WHERE account_id=$1 AND status IN ('submitted','approved')",
        [a.account.id],
      );
      assert(
        open < MAX_OPEN_PER_MEMBER,
        429,
        "too_many_open",
        "You have many open requests. Wait for some to be reviewed first.",
      );
      await q.query(
        "INSERT INTO reimbursements(id,office_id,account_id,payout_wallet,amount_units,category,spent_on,details_enc,receipt_enc) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          id,
          a.office.id,
          a.account.id,
          a.account.wallet!.toLowerCase(),
          units.toString(),
          input.category,
          day,
          crypto.seal(a.office.id, `reimbursement:${id}`, {
            vendor: input.vendor,
            note: input.note,
          }),
          receipt
            ? crypto.seal(a.office.id, `reimbursement-receipt:${id}`, receipt)
            : null,
        ],
      );
    });
    return { id, status: "submitted", amount: usdg(units) };
  }
  async function receipt(a: Access, id: string) {
    member(a);
    const [row] = await db.office(a.office.id, (q) =>
      q.query(
        "SELECT id,account_id,receipt_enc FROM reimbursements WHERE id=$1",
        [id],
      ),
    );
    assert(
      row && (row.account_id === a.account.id || reviewer(a)),
      404,
      "reimbursement_not_found",
      "Request not found.",
    );
    assert(
      row.receipt_enc,
      404,
      "receipt_missing",
      "No receipt was attached to this request.",
    );
    return {
      image: crypto.open(
        a.office.id,
        `reimbursement-receipt:${id}`,
        row.receipt_enc,
      ),
    };
  }
  async function approve(a: Access, body: unknown) {
    officer(a);
    const snapshot = active(a);
    const input = z
      .strictObject({
        ids: z.array(z.string().min(1).max(80)).min(1).max(MAX_BATCH),
      })
      .parse(body);
    const wanted = [...new Set(input.ids)];
    const check = (rows: any[]) => {
      assert(
        rows.length === wanted.length,
        404,
        "reimbursement_not_found",
        "One or more requests were not found.",
      );
      assert(
        rows.every((r) => r.status === "submitted"),
        409,
        "reimbursement_reviewed",
        "One or more requests were already reviewed.",
      );
      assert(
        a.role === "principal" ||
          rows.every((r) => r.account_id !== a.account.id),
        403,
        "self_approval",
        "Ask another Officer or a Principal to approve your own request.",
      );
    };
    const rows = await db.office(a.office.id, (q) =>
      q.query(
        `SELECT * FROM reimbursements WHERE ${IN_IDS} ORDER BY created_at`,
        [ids(wanted)],
      ),
    );
    check(rows);
    const seated = await db.office(a.office.id, (q) =>
      q.query(
        "SELECT DISTINCT account_id FROM seats WHERE revoked_at IS NULL AND account_id IN (SELECT jsonb_array_elements_text($1::jsonb))",
        [ids(rows.map((r: any) => r.account_id))],
      ),
    );
    assert(
      rows.every((r: any) => seated.some((s) => s.account_id === r.account_id)),
      409,
      "member_removed",
      "A requester no longer has a seat in this Office. Reject that request instead.",
    );
    const payments = rows.map((r: any) => ({
      id: r.id as string,
      to: r.payout_wallet as Address,
      units: BigInt(String(r.amount_units)),
      category: r.category as string,
    }));
    const calls = payments.map((p) => transferCall(p.to, p.units)),
      totalUnits = payments.reduce((t, p) => t + p.units, 0n);
    for (const call of calls) {
      const simulation = await chain.simulateCall(a.office.safe, call);
      assert(
        simulation.success,
        422,
        "simulation_failed",
        "The USDG transfer did not pass simulation from the Safe. Check the Safe's USDG balance.",
      );
    }
    // Claim the rows before proposing so two reviewers cannot pay the same request twice.
    await db.office(a.office.id, async (q) => {
      check(
        await q.query(
          `SELECT * FROM reimbursements WHERE ${IN_IDS} FOR UPDATE`,
          [ids(wanted)],
        ),
      );
      const [{ held }] = await q.query(
        "SELECT COALESCE(SUM(amount_units),0)::text AS held FROM reimbursements WHERE status='approved'",
      );
      assert(
        totalUnits + BigInt(held) <= snapshot.safeBalanceUnits,
        422,
        "insufficient_safe_balance",
        BigInt(held) > 0n
          ? `The Safe holds ${usdg(snapshot.safeBalanceUnits)} USDG and ${usdg(BigInt(held))} USDG is already approved for payout. Add USDG to the Safe or wait for pending payouts.`
          : balanceMessage(snapshot.safeBalanceUnits),
      );
      await q.query(
        `UPDATE reimbursements SET status='approved',reviewed_by=$2,reviewed_at=now() WHERE ${IN_IDS}`,
        [ids(wanted), a.account.id],
      );
    });
    try {
      const proposal = await offices.propose(a, "reimbursement", calls, {
        reimbursementIds: payments.map((p) => p.id),
        totalUsdg: usdg(totalUnits),
        token: ADDRESSES.usdg,
        payments: payments.map((p) => ({
          to: p.to,
          amountUsdg: usdg(p.units),
          category: p.category,
        })),
        simulated: true,
        requiresHumanSignatures: true,
      });
      await db.office(a.office.id, (q) =>
        q.query(`UPDATE reimbursements SET proposal_id=$2 WHERE ${IN_IDS}`, [
          ids(wanted),
          proposal.id,
        ]),
      );
      return {
        approved: payments.map((p) => p.id),
        totalUsdg: usdg(totalUnits),
        proposal,
      };
    } catch (error) {
      await db.office(a.office.id, (q) =>
        q.query(
          `UPDATE reimbursements SET status='submitted',reviewed_by=NULL,reviewed_at=NULL WHERE ${IN_IDS} AND status='approved' AND proposal_id IS NULL`,
          [ids(wanted)],
        ),
      );
      throw error;
    }
  }
  async function reject(a: Access, id: string, body: unknown) {
    officer(a);
    const input = z
      .strictObject({ reason: z.string().trim().min(1).max(500) })
      .parse(body);
    const [row] = await db.office(a.office.id, (q) =>
      q.query(
        "UPDATE reimbursements SET status='rejected',reason_enc=$2,reviewed_by=$3,reviewed_at=now() WHERE id=$1 AND status='submitted' RETURNING id",
        [
          id,
          crypto.seal(a.office.id, `reimbursement-reason:${id}`, input.reason),
          a.account.id,
        ],
      ),
    );
    assert(
      row,
      409,
      "reimbursement_reviewed",
      "Only requests waiting for review can be rejected.",
    );
    return { id, status: "rejected" };
  }
  async function withdraw(a: Access, id: string) {
    member(a);
    const [row] = await db.office(a.office.id, (q) =>
      q.query(
        "UPDATE reimbursements SET status='withdrawn' WHERE id=$1 AND account_id=$2 AND status='submitted' RETURNING id",
        [id, a.account.id],
      ),
    );
    assert(
      row,
      409,
      "reimbursement_reviewed",
      "Only your own requests that are still waiting for review can be withdrawn.",
    );
    return { id, status: "withdrawn" };
  }
  async function returnToReview(a: Access, id: string) {
    officer(a);
    const [request] = await db.office(a.office.id, (q) =>
      q.query("SELECT * FROM reimbursements WHERE id=$1", [id]),
    );
    assert(
      request?.status === "approved" && request.proposal_id,
      409,
      "reimbursement_reviewed",
      "Only an approved payout with a stale proposal can return to review.",
    );
    const [proposal] = await db.office(a.office.id, (q) =>
      q.query("SELECT * FROM office_proposals WHERE id=$1", [
        request.proposal_id,
      ]),
    );
    assert(
      proposal?.kind === "reimbursement" && proposal.status === "pending",
      409,
      "proposal_unavailable",
      "This payout requires reconciliation by a Safe owner.",
    );
    assert(
      await chain.safeNonceConsumed(a.office.safe, proposal.nonce),
      409,
      "proposal_still_executable",
      "This proposal can still execute. Its Safe nonce must be consumed before its payout can return to review.",
    );
    assert(
      !(await chain.findSafeExecution(
        a.office.safe,
        proposal.safe_tx_hash,
        proposal.created_block,
      )),
      409,
      "payout_already_executed",
      "This payout already executed. Ask a Safe owner to confirm it in Approvals.",
    );
    return db.office(a.office.id, async (q) => {
      await q.query("SELECT * FROM office_locks FOR UPDATE");
      const [current] = await q.query(
        "SELECT status FROM office_proposals WHERE id=$1 FOR UPDATE",
        [proposal.id],
      );
      assert(
        current?.status === "pending",
        409,
        "proposal_unavailable",
        "Proposal changed; reload the payout.",
      );
      const rows = await q.query(
        "UPDATE reimbursements SET status='submitted',proposal_id=NULL,reviewed_by=NULL,reviewed_at=NULL WHERE proposal_id=$1 AND status='approved' RETURNING id",
        [proposal.id],
      );
      assert(
        rows.length > 0,
        409,
        "reimbursement_reviewed",
        "These payouts have already changed.",
      );
      await q.query(
        "UPDATE office_proposals SET status='superseded' WHERE id=$1",
        [proposal.id],
      );
      return { status: "submitted", returned: rows.map((r) => r.id) };
    });
  }
  return { list, submit, receipt, approve, reject, withdraw, returnToReview };
}
export function register(ctx: FeatureContext) {
  const r = createReimbursements(ctx),
    gate = "reimbursements" as const;
  ctx.route(
    "post",
    "/reimbursements/:id/return-to-review",
    (a, req) => r.returnToReview(a, ctx.param(req, "id")),
    gate,
  );
  ctx.route("get", "/reimbursements", (a) => r.list(a), gate);
  ctx.route("post", "/reimbursements", (a, req) => r.submit(a, req.body), gate);
  ctx.route(
    "post",
    "/reimbursements/approve",
    (a, req) => r.approve(a, req.body),
    gate,
  );
  ctx.route(
    "get",
    "/reimbursements/:id/receipt",
    (a, req) => r.receipt(a, ctx.param(req, "id")),
    gate,
  );
  ctx.route(
    "post",
    "/reimbursements/:id/reject",
    (a, req) => r.reject(a, ctx.param(req, "id"), req.body),
    gate,
  );
  ctx.route(
    "post",
    "/reimbursements/:id/withdraw",
    (a, req) => r.withdraw(a, ctx.param(req, "id")),
    gate,
  );
}
