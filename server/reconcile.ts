import { assert } from "./errors.ts";
import { dollars, mulBps, picoToUsdString } from "../shared/money.ts";
import { rounded } from "./ledger.ts";
import { uid, envelopeLeaf } from "./crypto.ts";
import type { Runtime } from "./jobs.ts";
import type { Hex } from "viem";
import { clerkActor } from "./clerks.ts";
import { ZERO } from "../shared/chain.ts";

/** Operator-only recovery for expired, provably unpaid charges; signed history stays intact. */
export async function waiveExpiredReceipt(runtime: Runtime, input: {officeId: string; receiptId: string; evidenceHash: string}) {
  assert(/^[0-9a-f]{64}$/.test(input.evidenceHash), 400, "evidence_required", "Supply a verified recovery-record SHA-256.");
  return runtime.db.office(input.officeId, async q => {
    await q.query("SELECT * FROM office_locks FOR UPDATE");
    const [receipt] = await q.query("SELECT * FROM receipts WHERE id=$1 FOR UPDATE", [input.receiptId]);
    assert(receipt?.status === "final" && BigInt(receipt.charged_pico) > 0n,
      409, "receipt_not_collectible", "Select an original, charged final receipt.");
    if (receipt.request_id) {
      const [request] = await q.query("SELECT * FROM requests WHERE id=$1 FOR UPDATE", [receipt.request_id]);
      assert(request?.status === "complete" && request.receipt_id === receipt.id,
        409, "receipt_request_mismatch", "Receipt is not the completed request's current charge.");
    }
    let batch: {id: Hex; actorId: Hex} | undefined;
    if (receipt.settlement_id) {
      const [settlement] = await q.query("SELECT * FROM settlements WHERE id=$1 FOR UPDATE", [receipt.settlement_id]);
      const actor = receipt.actor_kind === "clerk" ? clerkActor(receipt.actor_id) : ZERO;
      assert(settlement && Number(settlement.period_start) === Number(receipt.period_start) &&
        settlement.actor_id === actor && Array.isArray(settlement.receipt_ids) && settlement.receipt_ids.includes(receipt.id),
        409, "settlement_mismatch", "The original settlement record is incomplete or inconsistent.");
      assert(settlement.status !== "confirmed", 409, "collection_already_paid", "The charge is already settled.");
      batch = {id: settlement.id, actorId: actor};
    }
    const proof = await runtime.chain.expiredCollectionProof(input.officeId as Hex, Number(receipt.period_start), batch);
    const id = uid("receipt_"), envelope = runtime.crypto.sign({type: "collection_waiver", id,
      officeId: input.officeId, requestId: receipt.request_id, actorId: receipt.actor_id, actorKind: receipt.actor_kind,
      status: "final", chargedUsd: "0", waivedUsd: picoToUsdString(BigInt(receipt.charged_pico)),
      periodStart: Number(receipt.period_start), amends: receipt.id, evidenceSha256: input.evidenceHash,
      finalizedProof: proof, operatorWaiver: true, issuedAt: new Date().toISOString()});
    // Preserve the original signature, Merkle leaf, amount and batch/anchor links.
    await q.query("UPDATE receipts SET status='waived' WHERE id=$1", [receipt.id]);
    await q.query("INSERT INTO receipts(id,office_id,request_id,actor_id,actor_kind,room_id,model,lane,charged_pico,envelope,leaf,period_start,status,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,'final','collection_waiver')",
      [id,input.officeId,receipt.request_id,receipt.actor_id,receipt.actor_kind,receipt.room_id,receipt.model,receipt.lane,
        JSON.stringify(envelope),envelopeLeaf(envelope),receipt.period_start]);
    if (receipt.request_id) await q.query("UPDATE requests SET charged_pico=0,receipt_id=$1 WHERE id=$2", [id,receipt.request_id]);
    return {id, envelope};
  });
}
export async function reconcileRequest(
  runtime: Runtime,
  input: {
    officeId: string;
    requestId: string;
    providerUsd: string;
    evidenceHash: string;
    waive?: boolean;
  },
) {
  const { db, chain, crypto } = runtime,
    providerCost = dollars(input.providerUsd, "1000000");
  assert(
    /^[0-9a-f]{64}$/.test(input.evidenceHash),
    400,
    "evidence_required",
    "Supply the SHA-256 of the verified provider billing evidence.",
  );
  return db.office(input.officeId, async (q) => {
    await q.query("SELECT * FROM office_locks FOR UPDATE");
    const [r] = await q.query("SELECT * FROM requests WHERE id=$1 FOR UPDATE", [
      input.requestId,
    ]);
    assert(
      r?.status === "uncertain",
      409,
      "request_not_uncertain",
      "Only an uncertain request can be reconciled.",
    );
    const [quote] = await q.query("SELECT * FROM quotes WHERE consumed_by=$1", [
      r.id,
    ]);
    assert(quote, 409, "quote_missing", "Original signed quote was not found.");
    let [pending] = await q.query(
      "SELECT * FROM receipts WHERE request_id=$1 AND status='pending' ORDER BY created_at LIMIT 1",
      [r.id],
    );
    if (!pending) {
      const id = uid("receipt_"),
        envelope = crypto.sign({
          type: "usage",
          id,
          officeId: input.officeId,
          requestId: r.id,
          actorId: r.actor_id,
          actorKind: r.actor_kind,
          status: "pending",
          chargedUsd: "0",
          maximumUsd: picoToUsdString(BigInt(r.reserved_pico)),
          reason: "outcome_uncertain",
          issuedAt: new Date().toISOString(),
        });
      [pending] = await q.query(
        "INSERT INTO receipts(id,office_id,request_id,actor_id,actor_kind,model,lane,charged_pico,envelope,leaf,period_start,status) VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,'pending') RETURNING *",
        [
          id,
          input.officeId,
          r.id,
          r.actor_id,
          r.actor_kind,
          r.model,
          r.lane,
          JSON.stringify(envelope),
          envelopeLeaf(envelope),
          r.period_start,
        ],
      );
    }
    const fee = mulBps(
        mulBps(providerCost, 500),
        10000 - quote.envelope.payload.discountBps,
      ),
      maximum = BigInt(r.reserved_pico),
      calculated = rounded(providerCost + fee),
      charged = input.waive ? 0n : calculated > maximum ? maximum : calculated;
    if (charged > 0n) {
      const s = await chain.snapshot(input.officeId as `0x${string}`);
      assert(
        s.active && s.periodStart === Number(r.period_start),
        409,
        "period_uncollectible",
        "The original allowance period is no longer collectible. Record an explicit waiver instead.",
      );
    }
    const id = uid("receipt_"),
      envelope = crypto.sign({
        type: "usage_amendment",
        id,
        officeId: input.officeId,
        requestId: r.id,
        actorId: r.actor_id,
        actorKind: r.actor_kind,
        roomId: r.room_id,
        model: r.model,
        lane: r.lane,
        periodStart: Number(r.period_start),
        status: "final",
        chargedUsd: picoToUsdString(charged),
        providerUsd: picoToUsdString(providerCost),
        platformFeeUsd: picoToUsdString(fee),
        maximumUsd: picoToUsdString(maximum),
        amends: pending.id,
        evidenceSha256: input.evidenceHash,
        operatorWaiver: !!input.waive,
        issuedAt: new Date().toISOString(),
      });
    await q.query(
      "INSERT INTO receipts(id,office_id,request_id,actor_id,actor_kind,room_id,model,lane,charged_pico,envelope,leaf,period_start,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'final')",
      [
        id,
        input.officeId,
        r.id,
        r.actor_id,
        r.actor_kind,
        r.room_id,
        r.model,
        r.lane,
        charged.toString(),
        JSON.stringify(envelope),
        envelopeLeaf(envelope),
        r.period_start,
      ],
    );
    await q.query(
      "UPDATE requests SET status='complete',provider_pico=$1,fee_pico=$2,charged_pico=$3,receipt_id=$4,error_code=NULL,completed_at=now() WHERE id=$5",
      [providerCost.toString(), fee.toString(), charged.toString(), id, r.id],
    );
    return { id, envelope };
  });
}
