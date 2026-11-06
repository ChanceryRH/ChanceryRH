import { z } from "zod";
import { reviewTransaction } from "../shared/transaction-review.ts";
import { ApiError } from "./errors.ts";
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
import type { Ledger } from "./ledger.ts";
export function createUpdates(
  db: Database,
  cfg: Config,
  chain: Chain,
  crypto: CryptoService,
  offices: Offices,
  clerks: Clerks,
  ledger: Ledger,
) {
  async function benefits(a: Access) {
    const eligibility = await ledger.benefitEligibility(a);
    return {
      token: cfg.tokenAddress,
      safe: a.office.safe,
      ...eligibility,
      discountAppliesTo: ["platform_fee", "seat_fee"],
      roadmapVote: eligibility.tier === 3,
      earlyFeatures: eligibility.tier >= 2,
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
      let transactionReview;
      try {
        transactionReview = reviewTransaction(call);
      } catch {
        throw new ApiError(
          400,
          "malformed_call",
          "A recognized transaction selector has invalid arguments.",
        );
      }
      return offices.propose(a, "safe_draft", [call], {
        clerkId,
        requesterExplanation: input.explanation,
        transactionReview,
        simulation,
        risks: transactionReview.risks,
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
    async vote(a: Access, body: unknown) {
      assert(
        a.role === "principal" && a.account.wallet,
        403,
        "principal_required",
        "A Safe owner must cast the Office vote.",
      );
      assert(
        (await benefits(a)).roadmapVote,
        403,
        "tier_required",
        "The Office needs the highest token tier to vote.",
      );
      const input = z
        .strictObject({
          topic: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
          choice: z.string().min(1).max(160),
          signature: z
            .string()
            .regex(/^0x[0-9a-fA-F]+$/)
            .max(10000),
        })
        .parse(body);
      const message = `Chancery roadmap vote\nChain: 4663\nRegistry: ${cfg.registry}\nOffice: ${a.office.id}\nTopic: ${input.topic}\nChoice: ${input.choice}`;
      assert(
        await chain.verifyWallet(
          a.account.wallet,
          message,
          input.signature as Hex,
        ),
        401,
        "signature_invalid",
        "The vote signature is invalid.",
      );
      await db.office(a.office.id, (q) =>
        q.query(
          "INSERT INTO roadmap_votes(office_id,topic,choice,signer) VALUES($1,$2,$3,$4) ON CONFLICT(office_id,topic) DO UPDATE SET choice=excluded.choice,signer=excluded.signer,created_at=now()",
          [a.office.id, input.topic, input.choice, a.account.wallet],
        ),
      );
      return { recorded: true, message };
    },
  };
}
