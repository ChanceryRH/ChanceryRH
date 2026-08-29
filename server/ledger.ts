import { z } from "zod";
import { ZERO } from "../shared/chain.ts";
import {
  dollars,
  mulBps,
  picoToUsdString,
  picoToUsdg,
  usdgToPico,
} from "../shared/money.ts";
import { checkGuards } from "../shared/guards.ts";
import {
  chatSchema,
  ProviderFailure,
  type Provider,
  type ChatInput,
} from "./provider.ts";
import {
  canonicalJson,
  hash,
  uid,
  envelopeLeaf,
  MerkleTree,
  type CryptoService,
} from "./crypto.ts";
import { assert, ApiError } from "./errors.ts";
import type { Database, Query } from "./db.ts";
import type { Offices, Access } from "./offices.ts";
import type { Chain, OfficeSnapshot } from "./chain.ts";
import type { Config } from "./config.ts";
export type Actor = {
  id: string;
  kind: "seat" | "clerk";
  cap: bigint;
  delegateActor: `0x${string}`;
  approvalId?: string;
  authorize?: (q: Query, input: ChatInput, maximum: bigint) => Promise<void>;
};
export const requestHash = (input: ChatInput) => hash(canonicalJson(input));
export const rounded = (amount: bigint) => usdgToPico(picoToUsdg(amount));
export function createLedger(
  db: Database,
  cfg: Config,
  chain: Chain,
  crypto: CryptoService,
  offices: Offices,
  provider: Provider,
) {
  const actorFor = (a: Access): Actor => ({
    id: a.seat.id,
    kind: "seat",
    cap: BigInt(a.seat.monthly_cap_pico),
    delegateActor: ZERO,
  });
  async function discount(a: Access) {
    if (!cfg.released.has("token_benefits")) return 0;
    const holding = await chain.tokenBalance(a.office.safe),
      whole = holding.balance / 10n ** BigInt(holding.decimals);
    return whole >= 25000000n
      ? 3000
      : whole >= 5000000n
        ? 2000
        : whole >= 1000000n
          ? 1000
          : 0;
  }
  function validate(a: Access, body: unknown) {
    offices.work(a);
    const input = chatSchema.parse(body),
      guard = checkGuards(...input.messages.map((m) => m.content));
    assert(
      !guard,
      400,
      "secret_detected",
      guard?.message || "Remove sensitive material before sending.",
    );
    const policy = a.office.policy;
    assert(
      !policy.allowedModels?.length ||
        policy.allowedModels.includes(input.model),
      403,
      "model_policy",
      "This model is not allowed by the Office policy.",
    );
    assert(
      policy.allowedLanes.includes(input.lane),
      403,
      "lane_policy",
      "This privacy mode is not allowed by the Office policy.",
    );
    return input;
  }
  async function context(q: Query, a: Access, input: ChatInput) {
    let ephemeral = input.lane === "zero_retention";
    if (input.conversationId) {
      const [c] = await q.query(
        "SELECT * FROM conversations WHERE id=$1 AND account_id=$2",
        [input.conversationId, a.account.id],
      );
      assert(c, 404, "conversation_not_found", "Conversation not found.");
      ephemeral ||= c.ephemeral;
    }
    if (input.roomId) {
      assert(
        cfg.released.has("rooms"),
        404,
        "update_unavailable",
        "Rooms are not released.",
      );
      const [room] = await q.query(
        "SELECT r.* FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE r.id=$1 AND m.account_id=$2 AND m.removed_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>now())",
        [input.roomId, a.account.id],
      );
      assert(
        room,
        403,
        "room_access_denied",
        "You are not a current member of this Room.",
      );
      assert(
        room.lane_policy !== "sealed",
        403,
        "sealed_inference_unavailable",
        "A sealed Room cannot send content to a server-side AI provider.",
      );
      assert(
        room.lane_policy !== "zero_retention" ||
          input.lane === "zero_retention",
        403,
        "room_privacy_policy",
        "This Room requires zero-retention inference.",
      );
      assert(
        !room.rotation_required,
        409,
        "rotation_required",
        "Rotate the Room key before continuing.",
      );
    }
    return { ephemeral };
  }
  async function quote(a: Access, body: unknown, actor = actorFor(a)) {
    const input = validate(a, body);
    await db.office(a.office.id, (q) => context(q, a, input));
    const estimate = await provider.estimate(input),
      discountBps = await discount(a);
    const fee = mulBps(
        mulBps(estimate.providerMaximum, 500),
        10000 - discountBps,
      ),
      maximum = rounded(estimate.providerMaximum + fee);
    assert(
      maximum <= dollars(a.office.policy.maxRequestUsd, "20"),
      402,
      "request_limit",
      "Lower the output limit or select a cheaper model.",
    );
    const id = uid("quote_"),
      expiresAt = new Date(Date.now() + 120000).toISOString();
    const envelope = crypto.sign({
      type: "quote",
      id,
      officeId: a.office.id,
      accountId: a.account.id,
      actorId: actor.id,
      requestHash: requestHash(input),
      model: input.model,
      lane: input.lane,
      maximumUsd: picoToUsdString(maximum),
      discountBps,
      platformFeeBps: 500,
      expiresAt,
      estimate: true,
    });
    await db.office(a.office.id, (q) =>
      q.query(
        "INSERT INTO quotes(id,office_id,account_id,request_hash,maximum_pico,envelope,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          a.office.id,
          a.account.id,
          requestHash(input),
          maximum.toString(),
          JSON.stringify(envelope),
          expiresAt,
        ],
      ),
    );
    return {
      id,
      maximumUsd: picoToUsdString(maximum),
      expiresAt,
      envelope,
      inputTokensEstimate: estimate.inputTokensEstimate,
    };
  }
  async function budget(
    q: Query,
    s: OfficeSnapshot,
    actor: Actor,
    amount: bigint,
  ) {
    assert(
      s.active &&
        s.moduleEnabled &&
        s.actorActive &&
        s.allowanceInterval === 43200 &&
        s.allowancePeriod === s.periodStart,
      402,
      "allowance_unavailable",
      "The Office allowance is inactive or out of sync.",
    );
    const [stale] = await q.query(
      "SELECT count(*)::int AS count FROM requests WHERE period_start<>$1 AND (status IN ('inflight','uncertain') OR (status='complete' AND EXISTS(SELECT 1 FROM receipts r LEFT JOIN settlements s ON r.settlement_id=s.id WHERE r.request_id=requests.id AND r.status='final' AND r.charged_pico>0 AND (s.status IS NULL OR s.status<>'confirmed'))))",
      [s.periodStart],
    );
    assert(
      !stale.count,
      409,
      "previous_period_unsettled",
      "The previous allowance period requires reconciliation before new spending.",
    );
    const rows = await q.query(
      "SELECT actor_id,actor_kind,coalesce(sum(reserved_pico),0)::text AS amount FROM requests WHERE status IN ('inflight','uncertain') GROUP BY actor_id,actor_kind",
    );
    const unpaid = await q.query(
      "SELECT r.actor_id,r.actor_kind,coalesce(sum(r.charged_pico),0)::text AS amount FROM receipts r LEFT JOIN settlements s ON r.settlement_id=s.id WHERE r.status='final' AND (s.status IS NULL OR s.status<>'confirmed') GROUP BY r.actor_id,r.actor_kind",
    );
    let officeHeld = 0n,
      delegateHeld = 0n;
    for (const row of [...rows, ...unpaid]) {
      const n = BigInt(row.amount);
      officeHeld += n;
      if (
        actor.kind === "seat"
          ? row.actor_kind === "seat"
          : row.actor_kind === "clerk" && row.actor_id === actor.id
      )
        delegateHeld += n;
    }
    const [used] = await q.query(
      "SELECT coalesce(sum(CASE WHEN status IN ('inflight','uncertain') THEN reserved_pico ELSE coalesce(charged_pico,0) END),0)::text AS amount FROM requests WHERE actor_id=$1 AND period_start=$2",
      [actor.id, s.periodStart],
    );
    const [seatFees] = await q.query(
      "SELECT coalesce(sum(charged_pico),0)::text AS amount FROM receipts WHERE actor_id=$1 AND period_start=$2 AND kind='seat_fee' AND status='final'",
      [actor.id, s.periodStart],
    );
    assert(
      BigInt(used.amount) + BigInt(seatFees.amount) + amount <= actor.cap,
      402,
      "actor_cap",
      "This seat or Clerk has reached its spending cap.",
    );
    assert(
      officeHeld + amount <= usdgToPico(s.capUnits - s.spentUnits),
      402,
      "office_cap",
      "The Office has insufficient available budget.",
    );
    assert(
      delegateHeld + amount <=
        usdgToPico(s.allowanceUnits - s.allowanceSpentUnits),
      402,
      "allowance_cap",
      "The Safe allowance has insufficient available budget.",
    );
    assert(
      officeHeld + amount <= usdgToPico(s.safeBalanceUnits),
      402,
      "safe_balance",
      "Fund the Safe with enough USDG before continuing.",
    );
  }
  async function receipt(
    q: Query,
    a: Access,
    r: any,
    status: "pending" | "final",
    charged: bigint,
    extra: object,
  ) {
    const id = uid("receipt_"),
      envelope = crypto.sign({
        type: "usage",
        id,
        officeId: a.office.id,
        requestId: r.id,
        actorId: r.actor_id,
        actorKind: r.actor_kind,
        roomId: r.room_id || null,
        model: r.model,
        lane: r.lane,
        periodStart: Number(r.period_start),
        status,
        chargedUsd: picoToUsdString(charged),
        issuedAt: new Date().toISOString(),
        ...extra,
      });
    await q.query(
      "INSERT INTO receipts(id,office_id,request_id,actor_id,actor_kind,model,lane,charged_pico,envelope,leaf,period_start,status,room_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [
        id,
        a.office.id,
        r.id,
        r.actor_id,
        r.actor_kind,
        r.model,
        r.lane,
        charged.toString(),
        JSON.stringify(envelope),
        envelopeLeaf(envelope),
        r.period_start,
        status,
        r.room_id || null,
      ],
    );
    return { id, envelope };
  }
  async function request(
    a: Access,
    body: unknown,
    actor = actorFor(a),
    onDelta?: (text: string) => void,
  ) {
    assert(
      cfg.providerKey,
      503,
      "provider_unconfigured",
      "The operator must configure PROVIDER_API_KEY.",
    );
    const input = z
        .strictObject({
          id: z.string().regex(/^[a-zA-Z0-9_-]{16,100}$/),
          quoteId: z.string().max(100),
          chat: chatSchema,
        })
        .parse(body),
      chat = validate(a, input.chat),
      digest = requestHash(chat);
    const reserved = await db.office(a.office.id, async (q) => {
      await q.query("SELECT * FROM office_locks FOR UPDATE");
      const [prior] = await q.query("SELECT * FROM requests WHERE id=$1", [
        input.id,
      ]);
      if (prior) {
        assert(
          prior.account_id === a.account.id &&
            prior.request_hash === digest &&
            prior.actor_id === actor.id,
          409,
          "idempotency_conflict",
          "This request ID is already bound to different content.",
        );
        return { prior };
      }
      const [quote] = await q.query(
        "SELECT * FROM quotes WHERE id=$1 FOR UPDATE",
        [input.quoteId],
      );
      assert(
        quote &&
          quote.account_id === a.account.id &&
          quote.request_hash === digest &&
          quote.envelope.payload.actorId === actor.id &&
          !quote.consumed_by &&
          new Date(quote.expires_at).getTime() > Date.now(),
        409,
        "quote_invalid",
        "Get a fresh quote for this exact request.",
      );
      const [seatFee] = await q.query(
        "SELECT receipt_id FROM seat_charges WHERE seat_id=$1 AND day=$2",
        [a.seat.id, Math.floor(Date.now() / 86400000)],
      );
      assert(
        seatFee,
        402,
        "seat_fee_due",
        "The daily seat fee must be reserved first. Ensure the Office has enough USDG and allowance; the worker retries automatically.",
      );
      const snapshot = await chain.snapshot(a.office.id, actor.delegateActor),
        maximum = BigInt(quote.maximum_pico);
      assert(
        snapshot.policyHash === a.snapshot!.policyHash &&
          snapshot.seatRoot === a.snapshot!.seatRoot,
        409,
        "office_changed",
        "The Office changed. Refresh before retrying.",
      );
      assert(
        a.role !== "principal" ||
          (!!a.account.wallet &&
            snapshot.owners.includes(
              a.account.wallet.toLowerCase() as `0x${string}`,
            )),
        403,
        "safe_owner_removed",
        "This wallet is no longer a Safe owner.",
      );
      const privacy = await context(q, a, chat);
      await actor.authorize?.(q, chat, maximum);
      await budget(q, snapshot, actor, maximum);
      if (actor.approvalId) {
        const [approval] = await q.query(
          "UPDATE approvals SET consumed_at=now() WHERE id=$1 AND clerk_id=$2 AND request_hash=$3 AND max_cost_pico>=$4 AND status='approved' AND consumed_at IS NULL AND expires_at>now() RETURNING id",
          [actor.approvalId, actor.id, digest, maximum.toString()],
        );
        assert(
          approval,
          409,
          "approval_invalid",
          "Approval expired, was consumed, or does not cover this request.",
        );
      }
      const [r] = await q.query(
        "INSERT INTO requests(id,office_id,account_id,actor_id,actor_kind,model,lane,request_hash,status,reserved_pico,period_start) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'inflight',$9,$10) RETURNING *",
        [
          input.id,
          a.office.id,
          a.account.id,
          actor.id,
          actor.kind,
          chat.model,
          chat.lane,
          digest,
          maximum.toString(),
          snapshot.periodStart,
        ],
      );
      await q.query(
        "UPDATE requests SET conversation_id=$1,room_id=$2 WHERE id=$3",
        [chat.conversationId || null, chat.roomId || null, r.id],
      );
      r.room_id = chat.roomId || null;
      await q.query("UPDATE quotes SET consumed_by=$1 WHERE id=$2", [
        input.id,
        input.quoteId,
      ]);
      return { r, quote, ephemeral: privacy.ephemeral };
    });
    if (reserved.prior) return status(a, input.id);
    const r = reserved.r!,
      quoteRecord = reserved.quote!;
    try {
      const result = await provider.complete(chat, onDelta);
      await db.office(a.office.id, async (q) => {
        await q.query("SELECT * FROM office_locks FOR UPDATE");
        const maximum = BigInt(r.reserved_pico),
          providerCost = result.cost;
        let charged = 0n,
          fee = 0n;
        if (providerCost !== null) {
          fee = mulBps(
            mulBps(providerCost, 500),
            10000 - quoteRecord.envelope.payload.discountBps,
          );
          charged = rounded(providerCost + fee);
          if (charged > maximum) charged = maximum;
        }
        const state = providerCost === null ? "uncertain" : "complete";
        const signed = await receipt(
          q,
          a,
          r,
          providerCost === null ? "pending" : "final",
          charged,
          {
            providerId: result.id,
            providerUsd:
              providerCost === null ? null : picoToUsdString(providerCost),
            platformFeeUsd: picoToUsdString(fee),
            maximumUsd: picoToUsdString(maximum),
            discountBps: quoteRecord.envelope.payload.discountBps,
            usage: result.usage,
            rawUsage: result.rawUsage,
            quoteId: input.quoteId,
            absorbedUsd:
              providerCost === null
                ? "0"
                : picoToUsdString(
                    providerCost + fee > charged
                      ? providerCost + fee - charged
                      : 0n,
                  ),
            rounding: "USDG unit; total never exceeds quote",
            reason: providerCost === null ? "provider_cost_missing" : null,
          },
        );
        // Zero-retention responses are delivered once and never stored.
        let response = !reserved.ephemeral
          ? crypto.seal(a.office.id, `request:${r.id}`, {
              content: result.content,
            })
          : null;
        if (chat.conversationId && !reserved.ephemeral) {
          const [conversation] = await q.query(
            "SELECT id FROM conversations WHERE id=$1 AND account_id=$2",
            [chat.conversationId, a.account.id],
          );
          if (!conversation) response = null;
          if (conversation)
            for (const message of [
              chat.messages[chat.messages.length - 1],
              { role: "assistant", content: result.content },
            ]) {
              const mid = uid("message_");
              await q.query(
                "INSERT INTO messages(id,office_id,conversation_id,account_id,role,content_enc,model) VALUES($1,$2,$3,$4,$5,$6,$7)",
                [
                  mid,
                  a.office.id,
                  chat.conversationId,
                  a.account.id,
                  message.role,
                  crypto.seal(a.office.id, `message:${mid}`, message.content),
                  chat.model,
                ],
              );
            }
        }
        await q.query(
          "UPDATE requests SET status=$1,provider_pico=$2,fee_pico=$3,charged_pico=$4,response_enc=$5,receipt_id=$6,provider_id=$7,completed_at=now() WHERE id=$8",
          [
            state,
            providerCost?.toString() ?? null,
            fee.toString(),
            charged.toString(),
            response,
            signed.id,
            result.id,
            r.id,
          ],
        );
      });
      return { ...(await status(a, input.id)), content: result.content };
    } catch (error) {
      const failure =
        error instanceof ProviderFailure
          ? error
          : new ProviderFailure("request_outcome_uncertain", true);
      await db.office(a.office.id, async (q) => {
        const [current] = await q.query(
          "SELECT * FROM requests WHERE id=$1 FOR UPDATE",
          [r.id],
        );
        if (current.status !== "inflight") return;
        const signed = await receipt(
          q,
          a,
          r,
          failure.uncertain ? "pending" : "final",
          0n,
          {
            reason: failure.code,
            maximumUsd: picoToUsdString(BigInt(r.reserved_pico)),
          },
        );
        await q.query(
          "UPDATE requests SET status=$1,error_code=$2,receipt_id=$3,charged_pico=$4,completed_at=now() WHERE id=$5",
          [
            failure.uncertain ? "uncertain" : "refused",
            failure.code,
            signed.id,
            failure.uncertain ? null : "0",
            r.id,
          ],
        );
      });
      return status(a, input.id);
    }
  }
  async function status(a: Access, id: string) {
    return db.office(a.office.id, async (q) => {
      const [r] = await q.query("SELECT * FROM requests WHERE id=$1", [id]);
      assert(
        r &&
          (r.account_id === a.account.id ||
            ["principal", "officer"].includes(a.role)),
        404,
        "request_not_found",
        "Request not found.",
      );
      const [signed] = await q.query(
        "SELECT envelope FROM receipts WHERE id=$1",
        [r.receipt_id],
      );
      return {
        id: r.id,
        status: r.status,
        content:
          r.account_id === a.account.id && r.response_enc
            ? crypto.open(a.office.id, `request:${r.id}`, r.response_enc)
                .content
            : null,
        reservedUsd: picoToUsdString(BigInt(r.reserved_pico)),
        chargedUsd:
          r.charged_pico === null
            ? null
            : picoToUsdString(BigInt(r.charged_pico)),
        receipt: signed?.envelope || null,
        error: r.error_code,
        replay:
          r.lane === "zero_retention" ? "content_not_retained" : undefined,
      };
    });
  }
  async function list(a: Access, month?: string) {
    assert(
      a.role !== "guest",
      403,
      "role_required",
      "Guests cannot access the Ledger.",
    );
    assert(
      !month || /^\d{4}-(0[1-9]|1[0-2])$/.test(month),
      400,
      "month_invalid",
      "Use YYYY-MM.",
    );
    return db.office(a.office.id, (q) =>
      q.query(
        "SELECT r.id,r.envelope,r.leaf,r.settlement_id,r.anchor_id,r.created_at FROM receipts r LEFT JOIN requests q ON r.request_id=q.id LEFT JOIN seats s ON r.actor_id=s.id WHERE ($1::text IS NULL OR to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM')=$1) AND ($2::boolean OR q.account_id=$3 OR s.account_id=$3) ORDER BY r.created_at DESC,r.id LIMIT 5000",
        [
          month || null,
          ["principal", "officer"].includes(a.role),
          a.account.id,
        ],
      ),
    );
  }
  async function* statement(a: Access, month?: string) {
    assert(
      a.role !== "guest",
      403,
      "role_required",
      "Guests cannot access the Ledger.",
    );
    assert(
      !month || /^\d{4}-(0[1-9]|1[0-2])$/.test(month),
      400,
      "month_invalid",
      "Use YYYY-MM.",
    );
    const cutoff = new Date().toISOString();
    let time: string | null = null,
      id: string | null = null;
    while (true) {
      const rows = await db.office(a.office.id, (q) =>
        q.query(
          "SELECT r.id,r.envelope,r.leaf,r.settlement_id,r.anchor_id,r.created_at,r.created_at::text AS cursor_time FROM receipts r LEFT JOIN requests q ON r.request_id=q.id LEFT JOIN seats s ON r.actor_id=s.id WHERE ($1::text IS NULL OR to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM')=$1) AND ($2::boolean OR q.account_id=$3 OR s.account_id=$3) AND r.created_at<=$4::timestamptz AND ($5::timestamptz IS NULL OR (r.created_at,r.id)<($5::timestamptz,$6::text)) ORDER BY r.created_at DESC,r.id DESC LIMIT 500",
          [
            month || null,
            ["principal", "officer"].includes(a.role),
            a.account.id,
            cutoff,
            time,
            id,
          ],
        ),
      );
      if (!rows.length) return;
      const last = rows[rows.length - 1];
      time = last.cursor_time;
      id = last.id;
      yield rows.map(({ cursor_time, ...row }) => row);
      if (rows.length < 500) return;
    }
  }
  async function proof(a: Access, id: string) {
    assert(
      a.role !== "guest",
      403,
      "role_required",
      "Guests cannot access the Ledger.",
    );
    return db.office(a.office.id, async (q) => {
      const [r] = await q.query(
        "SELECT r.*,s.account_id AS seat_account,q.account_id AS request_account FROM receipts r LEFT JOIN seats s ON r.actor_id=s.id LEFT JOIN requests q ON r.request_id=q.id WHERE r.id=$1",
        [id],
      );
      assert(
        r &&
          (["principal", "officer"].includes(a.role) ||
            r.seat_account === a.account.id ||
            r.request_account === a.account.id),
        404,
        "receipt_not_found",
        "Receipt not found.",
      );
      let anchor = null,
        settlement = null;
      for (const kind of ["anchor", "settlement"] as const) {
        const reference = kind === "anchor" ? r.anchor_id : r.settlement_id;
        if (!reference) continue;
        const [batch] = await q.query(
          `SELECT * FROM ${kind === "anchor" ? "receipt_anchors" : "settlements"} WHERE id=$1`,
          [reference],
        );
        if (!batch) continue;
        const leaves = await q.query(
          "SELECT id,leaf FROM receipts WHERE id=ANY($1::text[])",
          [batch.receipt_ids],
        );
        const tree = new MerkleTree(
            batch.receipt_ids.map(
              (rid: string) => leaves.find((x) => x.id === rid).leaf,
            ),
          ),
          value = {
            id: reference,
            root: tree.root,
            proof: tree.proof(batch.receipt_ids.indexOf(id)),
            status: batch.status,
            transactionHash: batch.tx_hash,
            chainId: 4663,
          };
        if (kind === "anchor") anchor = value;
        else settlement = value;
      }
      return { envelope: r.envelope, leaf: r.leaf, anchor, settlement };
    });
  }
  return {
    quote,
    request,
    status,
    list,
    statement,
    proof,
    discount,
    actorFor,
    budget,
    validate,
  };
}
export type Ledger = ReturnType<typeof createLedger>;
