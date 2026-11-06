import {
  encodeFunctionData,
  keccak256,
  toBytes,
  type Hex,
  type Address,
} from "viem";
import { ZERO, registryAbi, delegateAbi } from "../shared/chain.ts";
import {
  picoToUsdg,
  usdgToPico,
  picoToUsdString,
  mulBps,
} from "../shared/money.ts";
import { uid, canonicalJson, MerkleTree, envelopeLeaf } from "./crypto.ts";
import { clerkActor } from "./clerks.ts";
import { rounded } from "./ledger.ts";
import type { createApp } from "./app.ts";
import type { Access } from "./offices.ts";
export type Runtime = Awaited<ReturnType<typeof createApp>>;
export function createJobs(runtime: Runtime) {
  const { db, cfg, chain, crypto, ledger, offices, clerks } = runtime,
    owner = uid("worker_");
  async function lease() {
    const rows = await db.query(
      "INSERT INTO worker_leases(id,owner,expires_at) VALUES('settler',$1,now()+interval '5 minutes') ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at,heartbeat_at=now() WHERE worker_leases.expires_at<now() OR worker_leases.owner=excluded.owner RETURNING owner",
      [owner],
    );
    return !!rows.length;
  }
  async function broadcast(
    officeId: string,
    kind: string,
    reference: string,
    to: Address,
    data: Hex,
  ) {
    if (!(await lease())) return;
    let [entry] = await db.query(
      "SELECT * FROM transaction_outbox WHERE kind=$1 AND reference=$2",
      [kind, reference],
    );
    const retry = entry?.status === "failed" && kind === "settlement";
    if (retry) {
      if (
        entry.attempt_count >= 5 ||
        Date.now() - new Date(entry.confirmed_at).getTime() <
          Math.min(3600000, 60000 * 2 ** entry.attempt_count)
      )
        return;
      if (!(await chain.failedSubmissionFinalized(entry.transaction_hash)))
        return;
    }
    if (!entry || retry) {
      // Never allocate another nonce while a previous signed transaction is unresolved.
      const [pending] = await db.query(
        "SELECT id FROM transaction_outbox WHERE status='prepared' LIMIT 1",
      );
      if (pending) return;
      const signed = await chain.prepareSubmission(to, data),
        id = uid("tx_");
      entry = await db.transaction(async (q) => {
        const [lock] = await q.query(
          "SELECT owner,expires_at FROM worker_leases WHERE id='settler' FOR UPDATE",
        );
        if (
          lock?.owner !== owner ||
          new Date(lock.expires_at).getTime() <= Date.now()
        )
          return null;
        const [inflight] = await q.query(
          "SELECT id FROM transaction_outbox WHERE status='prepared' LIMIT 1",
        );
        if (inflight) return null;
        if (retry) {
          const [current] = await q.query(
            "SELECT * FROM transaction_outbox WHERE id=$1 FOR UPDATE",
            [entry.id],
          );
          if (
            current.status !== "failed" ||
            current.transaction_hash !== entry.transaction_hash
          )
            return null;
          await q.query(
            "INSERT INTO transaction_attempts(outbox_id,transaction_hash,raw_enc,status,confirmed_at) VALUES($1,$2,$3,'failed',$4) ON CONFLICT(transaction_hash) DO NOTHING",
            [
              current.id,
              current.transaction_hash,
              current.raw_enc,
              current.confirmed_at,
            ],
          );
          const [saved] = await q.query(
            "UPDATE transaction_outbox SET transaction_hash=$1,raw_enc=$2,status='prepared',confirmed_at=NULL,error_code=NULL,attempt_count=attempt_count+1 WHERE id=$3 RETURNING *",
            [
              signed.hash,
              crypto.seal(officeId, `transaction:${current.id}`, signed.raw),
              current.id,
            ],
          );
          return saved;
        }
        const [saved] = await q.query(
          "INSERT INTO transaction_outbox(id,office_id,kind,reference,transaction_hash,raw_enc) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            id,
            officeId,
            kind,
            reference,
            signed.hash,
            crypto.seal(officeId, `transaction:${id}`, signed.raw),
          ],
        );
        return saved;
      });
      if (!entry) return;
    }
    if (entry.status === "confirmed") return entry.transaction_hash;
    if (entry.status === "failed") return;
    try {
      await chain.broadcast(
        crypto.open(officeId, `transaction:${entry.id}`, entry.raw_enc),
      );
    } catch {
      /* A timeout or already-known response keeps the exact signed transaction for retry. */
    }
    return entry.transaction_hash;
  }
  async function outbox() {
    const entries = await db.query(
      "SELECT * FROM transaction_outbox WHERE status='prepared' ORDER BY created_at LIMIT 20",
    );
    for (const entry of entries) {
      const receipt = await chain
        .receipt(entry.transaction_hash)
        .catch(() => null);
      if (!receipt) {
        try {
          await chain.broadcast(
            crypto.open(
              entry.office_id,
              `transaction:${entry.id}`,
              entry.raw_enc,
            ),
          );
        } catch {}
        continue;
      }
      if (
        (await chain.client.getBlockNumber({ cacheTime: 0 })) <
        receipt.blockNumber + 1n
      )
        continue;
      const status = receipt.status === "success" ? "confirmed" : "failed";
      // Fence delayed observations by attempt, and commit tenant/outbox state atomically.
      await db.transaction(async (q) => {
        const [current] = await q.query(
          "SELECT status,transaction_hash FROM transaction_outbox WHERE id=$1 FOR UPDATE",
          [entry.id],
        );
        if (
          current?.status !== "prepared" ||
          current.transaction_hash !== entry.transaction_hash
        )
          return;
        await q.query("SELECT set_config('chancery.office_id', $1, true)", [
          entry.office_id,
        ]);
        await q.query("SET LOCAL ROLE chancery_office");
        if (entry.kind === "settlement")
          await q.query(
            "UPDATE settlements SET status=$1,tx_hash=$2,confirmed_at=CASE WHEN $1='confirmed' THEN now() ELSE NULL END WHERE id=$3",
            [status, entry.transaction_hash, entry.reference],
          );
        else if (entry.kind === "anchor")
          await q.query(
            "UPDATE receipt_anchors SET status=$1,tx_hash=$2 WHERE id=$3",
            [status, entry.transaction_hash, entry.reference],
          );
        else if (entry.kind === "minutes" && status === "confirmed")
          await q.query("UPDATE minutes SET tx_hash=$1 WHERE id=$2", [
            entry.transaction_hash,
            entry.reference,
          ]);
        await q.query("SET LOCAL ROLE chancery_service");
        await q.query(
          "UPDATE transaction_outbox SET status=$1,confirmed_at=now(),error_code=$2 WHERE id=$3",
          [
            status,
            status === "failed" ? "transaction_reverted" : null,
            entry.id,
          ],
        );
      });
    }
  }
  async function settle(office: any) {
    const snapshot = await chain.snapshot(office.id),
      now = Date.now(),
      day = Math.floor(now / 86400000),
      nearReset = (snapshot.periodStart + 43200) * 60000 - now < 3600000;
    if (!snapshot.active || !snapshot.moduleEnabled) return;
    const batches = await db.office(office.id, async (q) => {
      await q.query("SELECT * FROM office_locks FOR UPDATE");
      const [outstanding] = await q.query(
        "SELECT coalesce(sum(charged_pico),0)::text AS total FROM receipts WHERE status='final' AND charged_pico>0 AND settlement_id IS NULL",
      );
      const rows = await q.query(
        "SELECT * FROM receipts WHERE status='final' AND charged_pico>0 AND settlement_id IS NULL AND (created_at<$1 OR $2) ORDER BY created_at,id LIMIT 2000",
        [
          new Date(now - 3600000).toISOString(),
          nearReset || BigInt(outstanding.total) >= 10_000_000_000_000n,
        ],
      );
      const groups = new Map<string, any[]>();
      for (const row of rows) {
        const actor =
            row.actor_kind === "clerk" ? clerkActor(row.actor_id) : ZERO,
          key = `${actor}:${row.period_start}`;
        const group = groups.get(key) || [];
        group.push(row);
        groups.set(key, group);
      }
      for (const [key, receipts] of groups) {
        const [actor, period] = key.split(":");
        if (Number(period) !== snapshot.periodStart) continue;
        const tree = new MerkleTree(receipts.map((r) => r.leaf)),
          amount = receipts.reduce((n, r) => n + BigInt(r.charged_pico), 0n),
          id = keccak256(
            toBytes(
              canonicalJson({
                office: office.id,
                actor,
                period,
                root: tree.root,
                amount: amount.toString(),
              }),
            ),
          ),
          delegate = await chain.delegateFor(office.safe, actor as Hex);
        await q.query(
          "INSERT INTO settlements(id,office_id,actor_id,delegate,day,period_start,amount_usdg,receipt_root,receipt_ids,receipt_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING",
          [
            id,
            office.id,
            actor,
            delegate,
            day,
            period,
            picoToUsdg(amount).toString(),
            tree.root,
            JSON.stringify(receipts.map((r) => r.id)),
            receipts.length,
          ],
        );
        for (const receipt of receipts)
          await q.query("UPDATE receipts SET settlement_id=$1 WHERE id=$2", [
            id,
            receipt.id,
          ]);
      }
      return q.query(
        "SELECT * FROM settlements WHERE status IN ('prepared','failed') ORDER BY created_at LIMIT 20",
      );
    });
    for (const batch of batches) {
      if (Number(batch.period_start) !== snapshot.periodStart) continue;
      const data = encodeFunctionData({
        abi: delegateAbi,
        functionName: "settle",
        args: [
          batch.id,
          BigInt(batch.day),
          Number(batch.period_start),
          batch.receipt_root,
          batch.receipt_count,
          BigInt(batch.amount_usdg),
        ],
      });
      await broadcast(office.id, "settlement", batch.id, batch.delegate, data);
    }
  }
  async function anchors(office: any) {
    const hour = Math.floor(Date.now() / 3600000);
    const pending = await db.office(office.id, async (q) => {
      await q.query("SELECT * FROM office_locks FOR UPDATE");
      const rows = await q.query(
        "SELECT id,leaf,created_at FROM receipts WHERE anchor_id IS NULL AND created_at<$1 ORDER BY created_at,id",
        [new Date(hour * 3600000).toISOString()],
      );
      const groups = new Map<number, any[]>();
      for (const row of rows) {
        const h = Math.floor(new Date(row.created_at).getTime() / 3600000),
          group = groups.get(h) || [];
        group.push(row);
        groups.set(h, group);
      }
      for (const [h, receipts] of groups) {
        const id = uid("anchor_"),
          tree = new MerkleTree(receipts.map((r) => r.leaf));
        await q.query(
          "INSERT INTO receipt_anchors(id,office_id,hour,root,receipt_ids) VALUES($1,$2,$3,$4,$5)",
          [
            id,
            office.id,
            h,
            tree.root,
            JSON.stringify(receipts.map((r) => r.id)),
          ],
        );
        for (const receipt of receipts)
          await q.query("UPDATE receipts SET anchor_id=$1 WHERE id=$2", [
            id,
            receipt.id,
          ]);
      }
      return q.query(
        "SELECT * FROM receipt_anchors WHERE status='prepared' ORDER BY hour LIMIT 24",
      );
    });
    for (const a of pending)
      await broadcast(
        office.id,
        "anchor",
        a.id,
        cfg.registry!,
        encodeFunctionData({
          abi: registryAbi,
          functionName: "anchorReceipts",
          args: [office.id, BigInt(a.hour), a.root, a.receipt_ids.length],
        }),
      );
  }
  async function minutes(office: any) {
    if (!cfg.released.has("minutes")) return;
    const rows = await db.office(office.id, (q) =>
      q.query(
        "SELECT id,body_hash,envelope FROM minutes WHERE tx_hash IS NULL ORDER BY created_at LIMIT 20",
      ),
    );
    for (const m of rows)
      await broadcast(
        office.id,
        "minutes",
        m.id,
        cfg.registry!,
        encodeFunctionData({
          abi: registryAbi,
          functionName: "anchorMinutes",
          args: [
            office.id,
            m.body_hash,
            keccak256(Buffer.from(m.envelope.signature, "base64")),
          ],
        }),
      );
  }
  async function seatFees(office: any) {
    const s = await chain.snapshot(office.id);
    if (!s.active || !s.moduleEnabled) return;
    const today = new Date(),
      day = Math.floor(today.getTime() / 86400000),
      days = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0),
      ).getUTCDate();
    let discountBps = 0;
    if (cfg.released.has("token_benefits"))
      discountBps = await ledger.discount({ office } as Access);
    const base = 9000000000000n,
      discounted = base - mulBps(base, discountBps, "floor");
    // Distribute exact USDG units over calendar days; the full month sums to the advertised seat fee.
    const total = picoToUsdg(discounted),
      daily =
        total / BigInt(days) +
        (BigInt(today.getUTCDate()) <= total % BigInt(days) ? 1n : 0n),
      amount = usdgToPico(daily);
    await db.office(office.id, async (q) => {
      await q.query("SELECT * FROM office_locks FOR UPDATE");
      const seats = await q.query(
        "SELECT * FROM seats WHERE status='active' AND role<>'guest' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) AND NOT EXISTS(SELECT 1 FROM seat_charges c WHERE c.seat_id=seats.id AND c.day=$1)",
        [day],
      );
      for (const seat of seats) {
        if (
          seat.role === "principal" &&
          !s.owners.includes(seat.credential.slice(7))
        )
          continue;
        try {
          await ledger.budget(
            q,
            s,
            {
              id: seat.id,
              kind: "seat",
              cap: BigInt(seat.monthly_cap_pico),
              delegateActor: ZERO,
            },
            amount,
          );
        } catch (e: any) {
          if (e.status === 402 || e.code === "previous_period_unsettled")
            continue;
          throw e;
        }
        const id = uid("receipt_"),
          envelope = crypto.sign({
            type: "seat_fee",
            id,
            officeId: office.id,
            actorId: seat.id,
            actorKind: "seat",
            periodStart: s.periodStart,
            status: "final",
            chargedUsd: picoToUsdString(amount),
            monthlySeatUsd: "9",
            discountBps,
            day,
            calendarDays: days,
            issuedAt: new Date().toISOString(),
          });
        await q.query(
          "INSERT INTO receipts(id,office_id,actor_id,actor_kind,model,lane,charged_pico,envelope,leaf,period_start,kind) VALUES($1,$2,$3,'seat','seat','standard',$4,$5,$6,$7,'seat_fee')",
          [
            id,
            office.id,
            seat.id,
            amount.toString(),
            JSON.stringify(envelope),
            envelopeLeaf(envelope),
            s.periodStart,
          ],
        );
        await q.query(
          "INSERT INTO seat_charges(office_id,seat_id,day,receipt_id) VALUES($1,$2,$3,$4)",
          [office.id, seat.id, day, id],
        );
      }
    });
  }
  async function scheduled(office: any) {
    if (!cfg.released.has("clerks")) return;
    const due = await db.office(office.id, (q) =>
      q.query(
        "SELECT id,created_by,schedule_minutes FROM clerks WHERE status='active' AND schedule_minutes IS NOT NULL AND next_run_at<=now() ORDER BY next_run_at LIMIT 5",
      ),
    );
    for (const clerk of due) {
      await db.office(office.id, (q) =>
        q.query("UPDATE clerks SET next_run_at=$1 WHERE id=$2", [
          new Date(Date.now() + clerk.schedule_minutes * 60000).toISOString(),
          clerk.id,
        ]),
      );
      const [account] = await db.query("SELECT * FROM accounts WHERE id=$1", [
        clerk.created_by,
      ]);
      if (!account) continue;
      try {
        const a = await offices.access(account, office.id),
          prepared = await clerks.prepare(a, clerk.id, undefined);
        if (prepared.decision === "allow")
          await clerks.run(a, clerk.id, {
            id: uid("scheduled_"),
            quoteId: prepared.quote.id,
            chat: prepared.chat,
          });
      } catch (e: any) {
        console.error(
          JSON.stringify({
            event: "clerk_schedule_deferred",
            clerkId: clerk.id,
            code: e.code || "error",
          }),
        );
      }
    }
  }
  async function housekeeping(office: any) {
    await db.office(office.id, async (q) => {
      await q.query("DELETE FROM room_items WHERE expires_at<=now()");
      const interrupted = await q.query(
        "UPDATE requests SET status='uncertain',error_code='worker_restart' WHERE status='inflight' AND created_at<now()-interval '10 minutes' RETURNING *",
      );
      for (const r of interrupted) {
        const id = uid("receipt_"),
          envelope = crypto.sign({
            type: "usage",
            id,
            officeId: office.id,
            requestId: r.id,
            actorId: r.actor_id,
            actorKind: r.actor_kind,
            model: r.model,
            lane: r.lane,
            status: "pending",
            chargedUsd: "0",
            maximumUsd: picoToUsdString(BigInt(r.reserved_pico)),
            reason: "worker_restart",
            issuedAt: new Date().toISOString(),
          });
        await q.query(
          "INSERT INTO receipts(id,office_id,request_id,actor_id,actor_kind,model,lane,charged_pico,envelope,leaf,period_start,status) VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,'pending')",
          [
            id,
            office.id,
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
        await q.query("UPDATE requests SET receipt_id=$1 WHERE id=$2", [
          id,
          r.id,
        ]);
      }
      await q.query(
        "DELETE FROM quotes WHERE expires_at<now()-interval '1 day' AND consumed_by IS NULL",
      );
    });
  }
  async function tick() {
    if (!(await lease())) return { busy: true };
    let count = 0;
    const heartbeat = setInterval(() => {
      void lease().catch(() => {});
    }, 30000);
    heartbeat.unref();
    try {
      await outbox();
      const rows = await db.query(
        "SELECT * FROM offices WHERE status<>'pending' ORDER BY id",
      );
      for (const office of rows) {
        if (!(await lease())) break;
        try {
          await housekeeping(office);
          await seatFees(office);
          if (cfg.registry && cfg.settlerKey) {
            await settle(office);
            await anchors(office);
            await minutes(office);
          }
          await scheduled(office);
          count++;
        } catch (e: any) {
          console.error(
            JSON.stringify({
              event: "office_job_deferred",
              officeId: office.id,
              code: e.code || "error",
            }),
          );
        }
      }
      await db.query("DELETE FROM auth_challenges WHERE expires_at<now()");
      await db.query("DELETE FROM auth_sessions WHERE expires_at<now()");
      return { offices: count };
    } finally {
      clearInterval(heartbeat);
      await db.query(
        "UPDATE worker_leases SET expires_at=now() WHERE id='settler' AND owner=$1",
        [owner],
      );
    }
  }
  return { tick, outbox, settle, anchors, seatFees };
}
