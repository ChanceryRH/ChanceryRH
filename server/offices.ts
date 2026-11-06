import { z } from "zod";
import {
  encodeFunctionData,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import {
  ADDRESSES,
  ZERO,
  registryAbi,
  allowanceAbi,
  safeAbi,
  type SafeTransaction,
} from "../shared/chain.ts";
import {
  dollars,
  picoToUsdg,
  usdgToPico,
  picoToUsdString,
} from "../shared/money.ts";
import {
  officeIdFor,
  seatLeaf,
  type Chain,
  type OfficeSnapshot,
  type Call,
} from "./chain.ts";
import {
  canonicalJson,
  MerkleTree,
  uid,
  hash,
  type CryptoService,
} from "./crypto.ts";
import { ApiError, assert } from "./errors.ts";
import type { Account } from "./auth.ts";
import type { Database, Query } from "./db.ts";
import type { Config } from "./config.ts";
export const policySchema = z.strictObject({
  mandatoryGuards: z.literal(true).default(true),
  monthlySeatUsd: z.literal("9").default("9"),
  platformFeeBps: z.literal(500).default(500),
  allowedModels: z.array(z.string().min(1).max(160)).max(200).default([]),
  allowedLanes: z
    .array(z.enum(["standard", "zero_retention"]))
    .min(1)
    .default(["standard", "zero_retention"]),
  maxRequestUsd: z.string().default("1"),
});
export const policyHash = (policy: unknown) =>
  keccak256(toBytes(canonicalJson(policy)));
export type Access = {
  office: any;
  seat: any;
  role: "principal" | "officer" | "member" | "guest";
  snapshot: OfficeSnapshot | null;
  account: Account;
};
export type Offices = ReturnType<typeof createOffices>;
export function createOffices(
  db: Database,
  cfg: Config,
  chain: Chain,
  crypto: CryptoService,
) {
  function cap(value: unknown, max = "5000") {
    try {
      return dollars(value, max);
    } catch (e) {
      throw new ApiError(400, "amount_invalid", (e as Error).message);
    }
  }
  const root = (seats: any[]) =>
    new MerkleTree(
      [...seats]
        .sort((a, b) =>
          a.credential < b.credential
            ? -1
            : a.credential > b.credential
              ? 1
              : 0,
        )
        .map((s) => s.leaf as Hex),
    ).root;
  async function access(
    account: Account,
    id: string,
    roles?: string[],
    allowPending = false,
  ): Promise<Access> {
    assert(
      /^0x[0-9a-f]{64}$/i.test(id),
      404,
      "office_not_found",
      "Office not found.",
    );
    const [office] = await db.query("SELECT * FROM offices WHERE id=$1", [id]);
    assert(office, 404, "office_not_found", "Office not found.");
    assert(
      cfg.registry &&
        office.registry.toLowerCase() === cfg.registry.toLowerCase(),
      503,
      "registry_mismatch",
      "This Office belongs to a different Registry configuration.",
    );
    let snapshot: OfficeSnapshot | null = null,
      owners: string[] = [];
    if (office.status === "pending" && allowPending)
      owners = (await chain.safe(office.safe)).owners;
    else {
      snapshot = await chain.snapshot(id as Hex);
      owners = snapshot.owners;
    }
    const principal =
      !!account.wallet && owners.includes(account.wallet.toLowerCase());
    let seat = await db.office(id, async (q) => {
      const [s] = await q.query(
        "SELECT * FROM seats WHERE credential=$1 AND revoked_at IS NULL",
        [account.credential],
      );
      return s;
    });
    if (principal) {
      if (seat && !seat.account_id) {
        await db.office(id, (q) =>
          q.query(
            "UPDATE seats SET account_id=$1 WHERE id=$2 AND account_id IS NULL",
            [account.id, seat.id],
          ),
        );
        seat = { ...seat, account_id: account.id };
      }
      if (!seat) {
        const cap = (
            snapshot ? usdgToPico(snapshot.capUnits) : BigInt(office.cap_pico)
          ).toString(),
          leaf = seatLeaf(account.credential, "principal", cap, null);
        [seat] = await db.office(id, (q) =>
          q.query(
            "INSERT INTO seats(id,office_id,account_id,credential,role,monthly_cap_pico,status,leaf) VALUES($1,$2,$3,$4,'principal',$5,'pending',$6) ON CONFLICT(office_id,credential) DO UPDATE SET account_id=excluded.account_id,role='principal',status='pending',revoked_at=NULL,approved_root=NULL,leaf=excluded.leaf,monthly_cap_pico=excluded.monthly_cap_pico RETURNING *",
            [uid("seat_"), id, account.id, account.credential, cap, leaf],
          ),
        );
      }
      await db.query(
        "INSERT INTO office_access(office_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [id, account.id],
      );
    } else {
      assert(
        seat &&
          seat.account_id === account.id &&
          seat.role !== "principal" &&
          seat.status === "active" &&
          !seat.revoked_at,
        403,
        "office_access_denied",
        "Your seat does not have access to this Office.",
      );
      assert(
        !seat.expires_at || new Date(seat.expires_at).getTime() > Date.now(),
        403,
        "seat_expired",
        "This seat has expired.",
      );
      assert(
        snapshot && seat.approved_root === snapshot.seatRoot,
        403,
        "seat_not_approved",
        "The Safe has not approved this seat configuration.",
      );
      const seats = await db.office(id, (q) =>
        q.query(
          "SELECT * FROM seats WHERE status='active' AND approved_root=$1",
          [snapshot!.seatRoot],
        ),
      );
      const leaf = seatLeaf(
        seat.credential,
        seat.role,
        seat.monthly_cap_pico,
        seat.expires_at ? new Date(seat.expires_at).toISOString() : null,
      );
      assert(
        leaf === seat.leaf &&
          seats.length > 0 &&
          root(seats) === snapshot.seatRoot,
        403,
        "seat_proof_invalid",
        "Seat proof does not match the Safe-approved root.",
      );
    }
    const role = principal ? "principal" : seat.role;
    assert(
      !roles || roles.includes(role),
      403,
      "role_required",
      "Your Office role cannot perform this action.",
    );
    return { office, seat, role, snapshot, account };
  }
  function work(a: Access) {
    assert(
      a.snapshot?.active && a.snapshot.moduleEnabled,
      402,
      "office_read_only",
      "This Office is read-only. Restore its allowance or contact a Principal.",
    );
    assert(
      a.seat.status === "active",
      403,
      "seat_not_approved",
      "Approve this seat through the Safe before using paid features.",
    );
    assert(
      a.role !== "guest",
      403,
      "room_only",
      "Guests can access their assigned Room only.",
    );
    assert(
      policyHash(a.office.policy) === a.snapshot.policyHash,
      409,
      "policy_out_of_sync",
      "The Office policy is awaiting onchain synchronization.",
    );
  }
  async function propose(
    a: Access,
    kind: string,
    calls: Call[],
    payload: unknown,
  ) {
    assert(
      a.role === "principal" ||
        (["safe_draft", "reimbursement"].includes(kind) &&
          a.role === "officer"),
      403,
      "principal_required",
      "A Safe owner must prepare this change.",
    );
    const prepared = await chain.prepare(a.office.safe, calls),
      id = uid("proposal_");
    await db.office(a.office.id, (q) =>
      q.query(
        "INSERT INTO office_proposals(id,office_id,kind,safe_tx,payload,safe_tx_hash,nonce,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          a.office.id,
          kind,
          JSON.stringify(prepared.transaction),
          JSON.stringify({ ...(payload as object), calls }),
          prepared.safeTxHash,
          prepared.transaction.nonce,
          a.account.id,
        ],
      ),
    );
    return { id, kind, ...prepared };
  }
  async function reopenProposal(a: Access) {
    assert(
      a.office.status === "pending",
      409,
      "office_already_open",
      "This Office is no longer pending.",
    );
    const info = await chain.safe(a.office.safe),
      monthly = BigInt(a.office.cap_pico),
      seats = await db.office(a.office.id, (q) =>
        q.query("SELECT * FROM seats WHERE revoked_at IS NULL"),
      );
    const calls: Call[] = [];
    if (!info.moduleEnabled)
      calls.push({
        to: a.office.safe,
        data: encodeFunctionData({
          abi: safeAbi,
          functionName: "enableModule",
          args: [ADDRESSES.allowanceModule],
        }),
      });
    calls.push({
      to: ADDRESSES.allowanceModule,
      data: encodeFunctionData({
        abi: allowanceAbi,
        functionName: "addDelegate",
        args: [a.office.delegate],
      }),
    });
    calls.push({
      to: ADDRESSES.allowanceModule,
      data: encodeFunctionData({
        abi: allowanceAbi,
        functionName: "setAllowance",
        args: [
          a.office.delegate,
          ADDRESSES.usdg,
          picoToUsdg(monthly),
          43200,
          0,
        ],
      }),
    });
    calls.push({
      to: cfg.registry!,
      data: encodeFunctionData({
        abi: registryAbi,
        functionName: "open",
        args: [a.office.seat_root, a.office.policy_hash, picoToUsdg(monthly)],
      }),
    });
    return propose(a, "open", calls, {
      seatRoot: a.office.seat_root,
      policyHash: a.office.policy_hash,
      seats,
    });
  }
  async function create(account: Account, body: unknown) {
    const input = z
      .strictObject({
        safe: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        name: z.string().trim().min(1).max(80),
        monthlyCap: z.string(),
        policy: policySchema.optional(),
      })
      .parse(body);
    assert(
      account.wallet,
      403,
      "wallet_required",
      "Connect a Safe owner wallet to open an Office.",
    );
    const safeAddress = input.safe.toLowerCase() as Address,
      info = await chain.safe(safeAddress),
      network = await chain.configuration();
    assert(
      info.owners.includes(account.wallet.toLowerCase() as Address),
      403,
      "safe_owner_required",
      "This wallet is not an owner of that Safe.",
    );
    assert(
      safeAddress !== network.treasury.toLowerCase(),
      400,
      "treasury_conflict",
      "The paying Safe and Chancery revenue recipient must be different addresses.",
    );
    const id = officeIdFor(safeAddress),
      monthly = cap(input.monthlyCap);
    assert(
      monthly > 0n,
      400,
      "amount_invalid",
      "The allowance must be greater than zero.",
    );
    const policy = policySchema.parse(input.policy || {});
    cap(policy.maxRequestUsd, "20");
    const [existing] = await db.query("SELECT id FROM offices WHERE id=$1", [
      id,
    ]);
    assert(!existing, 409, "office_exists", "This Safe already has an Office.");
    const delegate = await chain.delegateFor(safeAddress),
      seats = info.owners.map((owner) => {
        const credential = `wallet:${owner.toLowerCase()}`;
        return {
          id: uid("seat_"),
          credential,
          role: "principal",
          monthly_cap_pico: monthly.toString(),
          expires_at: null,
          leaf: seatLeaf(credential, "principal", monthly.toString(), null),
        };
      });
    const seatRoot = root(seats),
      pHash = policyHash(policy);
    await db.query(
      "INSERT INTO offices(id,safe,name,registry,delegate,seat_root,policy_hash,policy,cap_pico,owners,threshold) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        id,
        safeAddress,
        input.name,
        cfg.registry,
        delegate,
        seatRoot,
        pHash,
        JSON.stringify(policy),
        monthly.toString(),
        JSON.stringify(info.owners),
        info.threshold,
      ],
    );
    await db.office(id, async (q) => {
      await q.query("INSERT INTO office_locks(office_id) VALUES($1)", [id]);
      for (const s of seats)
        await q.query(
          "INSERT INTO seats(id,office_id,account_id,credential,role,monthly_cap_pico,leaf) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            s.id,
            id,
            s.credential === account.credential ? account.id : null,
            s.credential,
            s.role,
            s.monthly_cap_pico,
            s.leaf,
          ],
        );
    });
    await db.query(
      "INSERT INTO office_access(office_id,account_id) VALUES($1,$2)",
      [id, account.id],
    );
    const a = await access(account, id, undefined, true),
      calls: Call[] = [];
    if (!info.moduleEnabled)
      calls.push({
        to: safeAddress,
        data: encodeFunctionData({
          abi: safeAbi,
          functionName: "enableModule",
          args: [ADDRESSES.allowanceModule],
        }),
      });
    calls.push({
      to: ADDRESSES.allowanceModule,
      data: encodeFunctionData({
        abi: allowanceAbi,
        functionName: "addDelegate",
        args: [delegate],
      }),
    });
    calls.push({
      to: ADDRESSES.allowanceModule,
      data: encodeFunctionData({
        abi: allowanceAbi,
        functionName: "setAllowance",
        args: [delegate, ADDRESSES.usdg, picoToUsdg(monthly), 43200, 0],
      }),
    });
    calls.push({
      to: cfg.registry!,
      data: encodeFunctionData({
        abi: registryAbi,
        functionName: "open",
        args: [seatRoot, pHash, picoToUsdg(monthly)],
      }),
    });
    return {
      officeId: id,
      proposal: await propose(a, "open", calls, {
        seatRoot,
        policyHash: pHash,
        seats,
      }),
    };
  }
  async function list(account: Account) {
    const rows = await db.query(
      "SELECT o.* FROM offices o WHERE EXISTS(SELECT 1 FROM office_access a WHERE a.office_id=o.id AND a.account_id=$1) OR ($2::text IS NOT NULL AND o.owners ? $2)",
      [account.id, account.wallet],
    );
    const result = [];
    for (const o of rows) {
      try {
        const a = await access(account, o.id, undefined, true);
        result.push({
          id: o.id,
          name: o.name,
          safe: o.safe,
          status: o.status,
          role: a.role,
        });
      } catch (e) {
        if (!(e instanceof ApiError && [401, 403, 404].includes(e.status)))
          throw e;
      }
    }
    return result;
  }
  async function get(a: Access) {
    const s = a.snapshot;
    return {
      id: a.office.id,
      name: a.office.name,
      safe: a.office.safe,
      status: s ? (s.active ? "active" : "closed") : a.office.status,
      role: a.role,
      seatId: a.seat.id,
      seatStatus: a.seat.status,
      policy: a.office.policy,
      chainId: 4663,
      allowancePeriodDays: 30,
      capUsd: s
        ? picoToUsdString(usdgToPico(s.capUnits))
        : picoToUsdString(BigInt(a.office.cap_pico)),
      spentUsd: s ? picoToUsdString(usdgToPico(s.spentUnits)) : "0",
      owners: s?.owners || a.office.owners,
      threshold: s?.threshold || a.office.threshold,
      moduleEnabled: s?.moduleEnabled || false,
      periodStart: s ? new Date(s.periodStart * 60000).toISOString() : null,
      delegate: a.office.delegate,
    };
  }
  async function changeSeats(a: Access, changes: unknown) {
    const input = z
      .strictObject({
        seats: z
          .array(
            z.strictObject({
              id: z.string(),
              role: z.enum(["officer", "member", "guest"]).optional(),
              monthlyCap: z.string().optional(),
              revoke: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(200),
      })
      .parse(changes);
    const rows = await db.office(a.office.id, (q) =>
      q.query("SELECT * FROM seats WHERE revoked_at IS NULL"),
    );
    for (const change of input.seats) {
      const s = rows.find((x) => x.id === change.id);
      assert(
        s &&
          (s.role !== "principal" ||
            (change.role === undefined &&
              change.monthlyCap === undefined &&
              !change.revoke)),
        400,
        "seat_invalid",
        "Safe owner seats are controlled by Safe ownership; submit only their ID to approve a new owner seat.",
      );
      if (change.revoke) {
        s.revoked_at = new Date().toISOString();
        continue;
      }
      if (change.role) s.role = change.role;
      if (change.monthlyCap !== undefined)
        s.monthly_cap_pico = cap(change.monthlyCap).toString();
    }
    for (const s of rows)
      if (
        s.role === "principal" &&
        a.snapshot &&
        !a.snapshot.owners.includes(s.credential.slice(7))
      )
        s.revoked_at = new Date().toISOString();
    const kept = rows
      .filter((s) => !s.revoked_at)
      .map((s) => ({
        ...s,
        expires_at: s.expires_at ? new Date(s.expires_at).toISOString() : null,
      }));
    for (const s of kept)
      s.leaf = seatLeaf(s.credential, s.role, s.monthly_cap_pico, s.expires_at);
    const seatRoot = root(kept);
    return propose(
      a,
      "seats",
      [
        {
          to: cfg.registry!,
          data: encodeFunctionData({
            abi: registryAbi,
            functionName: "setSeats",
            args: [a.office.id, seatRoot],
          }),
        },
      ],
      {
        seatRoot,
        seats: kept,
        revokedIds: rows.filter((s) => s.revoked_at).map((s) => s.id),
      },
    );
  }
  async function invite(a: Access, body: unknown) {
    assert(
      ["principal", "officer"].includes(a.role),
      403,
      "role_required",
      "An Officer or Principal must invite members.",
    );
    const input = z
      .strictObject({
        role: z.enum(["officer", "member", "guest"]).default("member"),
        monthlyCap: z.string().default("50"),
        expiresInHours: z.number().int().min(1).max(168).default(48),
        roomId: z.string().optional(),
      })
      .parse(body);
    assert(
      a.role === "principal" || input.role !== "officer",
      403,
      "principal_required",
      "Only Principals can invite Officers.",
    );
    if (input.role === "guest") {
      assert(
        cfg.released.has("rooms") && input.roomId,
        400,
        "guest_room_required",
        "A guest invite requires an enabled Room.",
      );
      const [room] = await db.office(a.office.id, (q) =>
        q.query(
          "SELECT r.id FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE r.id=$1 AND m.account_id=$2 AND m.removed_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>now())",
          [input.roomId, a.account.id],
        ),
      );
      assert(
        room,
        403,
        "room_access_denied",
        "Invite guests only to a Room you belong to.",
      );
    }
    const token = uid(),
      expiresAt = new Date(
        Date.now() + input.expiresInHours * 3600000,
      ).toISOString();
    await db.office(a.office.id, (q) =>
      q.query(
        "INSERT INTO invites(token_hash,office_id,role,monthly_cap_pico,expires_at,room_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          hash(token),
          a.office.id,
          input.role,
          cap(input.monthlyCap).toString(),
          expiresAt,
          input.roomId || null,
          a.account.id,
        ],
      ),
    );
    return { token, officeId: a.office.id, expiresAt, approvalRequired: true };
  }
  async function claim(account: Account, id: string, token: string) {
    assert(
      typeof token === "string" && token.length === 32,
      400,
      "invite_invalid",
      "Invite is invalid.",
    );
    const result = await db.office(id, async (q) => {
      const [invite] = await q.query(
        "SELECT * FROM invites WHERE token_hash=$1 AND claimed_by IS NULL AND expires_at>now() FOR UPDATE",
        [hash(token)],
      );
      assert(
        invite,
        404,
        "invite_invalid",
        "Invite expired or was already claimed.",
      );
      const [prior] = await q.query(
        "SELECT * FROM seats WHERE account_id=$1 OR credential=$2",
        [account.id, account.credential],
      );
      assert(
        !prior || prior.status === "revoked",
        409,
        "seat_exists",
        "This account already has a seat.",
      );
      const seatId = prior?.id || uid("seat_"),
        expires =
          invite.role === "guest"
            ? new Date(invite.expires_at).toISOString()
            : null;
      await q.query(
        "INSERT INTO seats(id,office_id,account_id,credential,role,monthly_cap_pico,expires_at,leaf) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET role=excluded.role,monthly_cap_pico=excluded.monthly_cap_pico,expires_at=excluded.expires_at,leaf=excluded.leaf,status='pending',revoked_at=NULL,approved_root=NULL",
        [
          seatId,
          id,
          account.id,
          account.credential,
          invite.role,
          invite.monthly_cap_pico,
          expires,
          seatLeaf(
            account.credential,
            invite.role,
            invite.monthly_cap_pico,
            expires,
          ),
        ],
      );
      await q.query("UPDATE invites SET claimed_by=$1 WHERE token_hash=$2", [
        account.id,
        hash(token),
      ]);
      return { seatId, status: "pending", approvalRequired: true };
    });
    await db.query(
      "INSERT INTO office_access(office_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [id, account.id],
    );
    return result;
  }
  async function proposal(a: Access, id: string) {
    assert(
      a.role === "principal",
      403,
      "principal_required",
      "Only Safe owners can review this queue.",
    );
    const [p] = await db.office(a.office.id, (q) =>
      q.query("SELECT * FROM office_proposals WHERE id=$1", [id]),
    );
    assert(p, 404, "proposal_not_found", "Proposal not found.");
    return p;
  }
  async function signProposal(a: Access, id: string, signature: Hex) {
    const p = await proposal(a, id);
    assert(
      p.status === "pending",
      409,
      "proposal_complete",
      "This proposal is no longer pending.",
    );
    assert(
      /^0x[0-9a-fA-F]{130}$/.test(signature),
      400,
      "signature_invalid",
      "Use an EIP-712 owner signature.",
    );
    const owner = await chain.ownerOfSignature(
        a.office.safe,
        p.safe_tx,
        signature,
      ),
      info = await chain.safe(a.office.safe);
    assert(
      owner === a.account.wallet?.toLowerCase() && info.owners.includes(owner),
      403,
      "safe_owner_required",
      "Signature is not from the connected current Safe owner.",
    );
    assert(
      info.nonce === p.nonce,
      409,
      "proposal_stale",
      "Safe nonce changed. Prepare this proposal again.",
    );
    await db.office(a.office.id, (q) =>
      q.query(
        "INSERT INTO safe_signatures(office_id,proposal_id,owner,signature) VALUES($1,$2,$3,$4) ON CONFLICT(proposal_id,owner) DO UPDATE SET signature=excluded.signature",
        [a.office.id, id, owner, signature],
      ),
    );
    return execution(a, id);
  }
  async function execution(a: Access, id: string) {
    const p = await proposal(a, id),
      info = await chain.safe(a.office.safe);
    assert(
      info.nonce === p.nonce,
      409,
      "proposal_stale",
      "Safe nonce changed. Prepare a fresh proposal.",
    );
    const saved = await db.office(a.office.id, (q) =>
      q.query(
        "SELECT owner,signature FROM safe_signatures WHERE proposal_id=$1",
        [id],
      ),
    );
    const signatures = [];
    for (const s of saved)
      if (
        info.owners.includes(s.owner) &&
        (await chain.ownerOfSignature(
          a.office.safe,
          p.safe_tx,
          s.signature,
        )) === s.owner
      )
        signatures.push(s);
    return {
      id,
      safe: a.office.safe,
      safeTxHash: p.safe_tx_hash,
      transaction: p.safe_tx,
      signatures,
      threshold: info.threshold,
      ready: signatures.length >= info.threshold,
      execution:
        signatures.length >= info.threshold
          ? {
              to: a.office.safe,
              data: chain.execution(p.safe_tx, signatures),
              value: "0",
              chainId: 4663,
            }
          : null,
    };
  }
  async function confirm(a: Access, id: string, txHash: Hex) {
    const p = await proposal(a, id);
    if (p.status === "confirmed") return { status: "confirmed" };
    assert(
      await chain.confirmedSafeTransaction(
        txHash,
        a.office.safe,
        p.safe_tx_hash,
      ),
      409,
      "transaction_pending",
      "A confirmed successful Safe execution was not found.",
    );
    const s = await chain.snapshot(a.office.id);
    if (p.kind === "open" || p.kind === "seats") {
      assert(
        s.seatRoot === p.payload.seatRoot,
        409,
        "root_mismatch",
        "The onchain seat root differs from this proposal.",
      );
      await db.office(a.office.id, async (q) => {
        for (const seat of p.payload.seats)
          await q.query(
            "UPDATE seats SET role=$1,monthly_cap_pico=$2,expires_at=$3,leaf=$4,approved_root=$5,status='active',revoked_at=NULL WHERE id=$6",
            [
              seat.role,
              seat.monthly_cap_pico,
              seat.expires_at,
              seat.leaf,
              s.seatRoot,
              seat.id,
            ],
          );
        for (const seatId of p.payload.revokedIds || []) {
          const [removed] = await q.query(
            "UPDATE seats SET revoked_at=now(),status='revoked' WHERE id=$1 RETURNING account_id",
            [seatId],
          );
          if (removed?.account_id) {
            await q.query(
              "UPDATE room_members SET removed_at=now() WHERE account_id=$1",
              [removed.account_id],
            );
            await q.query(
              "UPDATE rooms SET rotation_required=true WHERE id IN(SELECT room_id FROM room_members WHERE account_id=$1)",
              [removed.account_id],
            );
          }
        }
      });
      await db.query(
        "UPDATE offices SET seat_root=$1,status='active',synced_at=now() WHERE id=$2",
        [s.seatRoot, a.office.id],
      );
    } else if (p.kind === "policy") {
      assert(
        s.policyHash === p.payload.policyHash,
        409,
        "policy_mismatch",
        "The onchain policy differs.",
      );
      await db.query(
        "UPDATE offices SET policy=$1,policy_hash=$2 WHERE id=$3",
        [JSON.stringify(p.payload.policy), s.policyHash, a.office.id],
      );
    } else if (p.kind === "clerk") {
      const cs = await chain.snapshot(a.office.id, p.payload.actorId);
      assert(
        cs.actorActive &&
          cs.allowanceUnits === BigInt(p.payload.allowanceUnits),
        409,
        "clerk_mismatch",
        "The Clerk allowance is not active.",
      );
      await db.office(a.office.id, (q) =>
        q.query(
          "UPDATE clerks SET status='active',delegate=$1,next_run_at=now() WHERE id=$2",
          [cs.delegate, p.payload.clerkId],
        ),
      );
    } else if (p.kind === "reimbursement") {
      // Only the Reimbursements update proposes this kind; mark its requests paid.
      await db.office(a.office.id, (q) =>
        q.query(
          "UPDATE reimbursements SET status='paid',proposal_id=$1,tx_hash=$2,paid_at=now() WHERE status='approved' AND id IN (SELECT jsonb_array_elements_text($3::jsonb))",
          [id, txHash, JSON.stringify(p.payload.reimbursementIds || [])],
        ),
      );
    }
    await db.query(
      "UPDATE offices SET owners=$1,threshold=$2,chain_block=$3,cap_pico=$4,status=$5,synced_at=now() WHERE id=$6",
      [
        JSON.stringify(s.owners),
        s.threshold,
        s.block,
        usdgToPico(s.capUnits).toString(),
        s.active ? "active" : "closed",
        a.office.id,
      ],
    );
    await db.office(a.office.id, (q) =>
      q.query(
        "UPDATE office_proposals SET status='confirmed',tx_hash=$1 WHERE id=$2",
        [txHash, id],
      ),
    );
    return { status: "confirmed", txHash };
  }
  return {
    access,
    work,
    create,
    list,
    get,
    propose,
    reopenProposal,
    async refreshProposal(a: Access, id: string) {
      const p = await proposal(a, id);
      assert(
        p.status === "pending" && Array.isArray(p.payload.calls),
        409,
        "proposal_unavailable",
        "This proposal cannot be refreshed.",
      );
      const fresh = await propose(a, p.kind, p.payload.calls, p.payload);
      await db.office(a.office.id, (q) =>
        q.query("UPDATE office_proposals SET status='superseded' WHERE id=$1", [
          id,
        ]),
      );
      return fresh;
    },
    changeSeats,
    invite,
    claim,
    proposal,
    signProposal,
    execution,
    confirm,
    cap,
    async seats(a: Access) {
      assert(
        ["principal", "officer"].includes(a.role),
        403,
        "role_required",
        "An Officer or Principal must view seats.",
      );
      return db.office(a.office.id, (q) =>
        q.query(
          "SELECT id,account_id,credential,role,monthly_cap_pico,expires_at,status,revoked_at FROM seats ORDER BY created_at",
        ),
      );
    },
    async queue(a: Access) {
      assert(
        a.role === "principal",
        403,
        "principal_required",
        "A Principal must view Safe proposals.",
      );
      return db.office(a.office.id, (q) =>
        q.query(
          "SELECT id,kind,status,safe_tx_hash,nonce,created_at FROM office_proposals ORDER BY created_at DESC LIMIT 100",
        ),
      );
    },
    async changePolicy(a: Access, body: unknown) {
      const policy = policySchema.parse(body);
      cap(policy.maxRequestUsd, "20");
      const h = policyHash(policy);
      return propose(
        a,
        "policy",
        [
          {
            to: cfg.registry!,
            data: encodeFunctionData({
              abi: registryAbi,
              functionName: "setPolicy",
              args: [a.office.id, h],
            }),
          },
        ],
        { policy, policyHash: h },
      );
    },
    async changeCap(a: Access, value: unknown) {
      assert(a.snapshot, 409, "office_pending", "Open the Office first.");
      const amount = picoToUsdg(cap(value));
      return propose(
        a,
        "cap",
        [
          {
            to: cfg.registry!,
            data: encodeFunctionData({
              abi: registryAbi,
              functionName: "setCap",
              args: [a.office.id, amount],
            }),
          },
          {
            to: ADDRESSES.allowanceModule,
            data: encodeFunctionData({
              abi: allowanceAbi,
              functionName: "setAllowance",
              args: [
                a.office.delegate,
                ADDRESSES.usdg,
                amount,
                43200,
                a.snapshot.periodStart,
              ],
            }),
          },
        ],
        { capUsd: picoToUsdString(usdgToPico(amount)) },
      );
    },
    async close(a: Access) {
      return propose(
        a,
        "close",
        [
          {
            to: cfg.registry!,
            data: encodeFunctionData({
              abi: registryAbi,
              functionName: "close",
              args: [a.office.id],
            }),
          },
        ],
        { permanent: true },
      );
    },
  };
}
