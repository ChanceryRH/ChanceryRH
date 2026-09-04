import { z } from "zod";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { uid, hash, type CryptoService } from "./crypto.ts";
import { assert } from "./errors.ts";
import { checkGuards } from "../shared/guards.ts";
import { ADDRESSES } from "../shared/chain.ts";
import type { Database } from "./db.ts";
import type { Config } from "./config.ts";
import type { Chain } from "./chain.ts";
import type { Access, Offices } from "./offices.ts";
import type { Clerks } from "./clerks.ts";
export function createUpdates(
  db: Database,
  cfg: Config,
  chain: Chain,
  crypto: CryptoService,
  offices: Offices,
  clerks: Clerks,
) {
  async function benefits(a: Access) {
    const holding = await chain.tokenBalance(a.office.safe),
      units = holding.balance / 10n ** BigInt(holding.decimals),
      tier =
        units >= 25000000n
          ? 3
          : units >= 5000000n
            ? 2
            : units >= 1000000n
              ? 1
              : 0;
    return {
      token: cfg.tokenAddress,
      safe: a.office.safe,
      balance: holding.balance.toString(),
      decimals: holding.decimals,
      tier,
      discountPercent: [0, 10, 20, 30][tier],
      discountAppliesTo: ["platform_fee", "seat_fee"],
      roadmapVote: tier === 3,
      earlyFeatures: tier >= 2,
    };
  }
  return {
    benefits,
    async draft(a: Access, clerkId: string, body: unknown) {
      const clerk = await clerks.load(a, clerkId);
      assert(
        clerk.status === "active",
        409,
        "clerk_inactive",
        "This Clerk is not active.",
      );
      const input = z
        .strictObject({
          to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
          data: z
            .string()
            .regex(/^0x([0-9a-fA-F]{2})*$/)
            .max(40000),
          value: z
            .string()
            .regex(/^\d{1,60}$/)
            .default("0"),
          explanation: z.string().min(1).max(4000),
        })
        .parse(body);
      // Infrastructure mutations use the reviewed Office flows, not arbitrary Clerk drafts.
      const protectedAddresses = [
        a.office.safe,
        cfg.registry,
        ADDRESSES.safeSingleton,
        ADDRESSES.safeFactory,
        ADDRESSES.multiSend,
        ADDRESSES.allowanceModule,
      ]
        .filter(Boolean)
        .map((v) => v!.toLowerCase());
      assert(
        !protectedAddresses.includes(input.to.toLowerCase()),
        400,
        "protected_target",
        "Use the Office controls for Safe, allowance, and Registry changes.",
      );
      const call = {
        to: input.to as Address,
        data: input.data as Hex,
        value: input.value,
      };
      const simulation = await chain.simulateCall(a.office.safe, call);
      assert(
        simulation.success,
        422,
        "simulation_failed",
        "This draft did not pass simulation.",
      );
      const selector = input.data.slice(0, 10).toLowerCase(),
        risks = [
          ...(BigInt(input.value) > 0n ? ["Transfers native ETH"] : []),
          ...(["0x095ea7b3", "0xa22cb465"].includes(selector)
            ? ["Grants token spending permission"]
            : []),
          ...(input.data.length > 2
            ? ["Calls contract code; review target and calldata"]
            : []),
        ];
      return offices.propose(a, "safe_draft", [call], {
        clerkId,
        explanation: input.explanation,
        simulation,
        risks,
        requiresHumanSignatures: true,
      });
    },
    async minutes(a: Access, body: unknown) {
      assert(
        ["principal", "officer"].includes(a.role),
        403,
        "officer_required",
        "An Officer or Principal must issue Minutes.",
      );
      offices.work(a);
      const input = z
          .strictObject({ body: z.string().min(1).max(100000) })
          .parse(body),
        guard = checkGuards(input.body);
      assert(
        !guard,
        400,
        "secret_detected",
        guard?.message || "Secret detected.",
      );
      const id = uid("minutes_"),
        bodyHash = keccak256(toBytes(input.body)),
        envelope = crypto.sign({
          type: "minutes",
          id,
          officeId: a.office.id,
          bodyHash,
          createdBy: a.account.credential,
          issuedAt: new Date().toISOString(),
        });
      await db.office(a.office.id, (q) =>
        q.query(
          "INSERT INTO minutes(id,office_id,body_enc,body_hash,envelope,created_by) VALUES($1,$2,$3,$4,$5,$6)",
          [
            id,
            a.office.id,
            crypto.seal(a.office.id, `minutes:${id}`, input.body),
            bodyHash,
            JSON.stringify(envelope),
            a.account.id,
          ],
        ),
      );
      return { id, bodyHash, envelope, anchorStatus: "pending" };
    },
    async listMinutes(a: Access) {
      assert(
        a.role !== "guest",
        403,
        "role_required",
        "Guests cannot view Office Minutes.",
      );
      return db.office(a.office.id, async (q) =>
        (
          await q.query(
            "SELECT * FROM minutes ORDER BY created_at DESC LIMIT 100",
          )
        ).map((m) => ({
          id: m.id,
          body: crypto.open(a.office.id, `minutes:${m.id}`, m.body_enc),
          bodyHash: m.body_hash,
          envelope: m.envelope,
          transactionHash: m.tx_hash,
        })),
      );
    },
    
  };
}
