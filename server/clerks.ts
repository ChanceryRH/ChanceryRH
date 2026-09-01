import { z } from "zod";
import {
  keccak256,
  toBytes,
  encodeFunctionData,
  type Hex,
  type Address,
} from "viem";
import { evaluateClerkPolicy, rulebookSchema } from "../shared/clerk-policy.ts";
export { rulebookSchema };
import { dollars, picoToUsdg, picoToUsdString } from "../shared/money.ts";
import { ADDRESSES, registryAbi, allowanceAbi } from "../shared/chain.ts";
import { checkGuards } from "../shared/guards.ts";
import { chatSchema, type ChatInput } from "./provider.ts";
import { requestHash, type Ledger, type Actor } from "./ledger.ts";
import { uid, type CryptoService } from "./crypto.ts";
import { assert, ApiError } from "./errors.ts";
import type { Access, Offices } from "./offices.ts";
import type { Query, Database } from "./db.ts";
import type { Chain } from "./chain.ts";
import type { Config } from "./config.ts";
export const clerkActor = (id: string) =>
  keccak256(toBytes(`chancery:clerk:${id}`));
export function createClerks(
  db: Database,
  cfg: Config,
  chain: Chain,
  crypto: CryptoService,
  offices: Offices,
  ledger: Ledger,
) {
  function officer(a: Access) {
    assert(
      ["principal", "officer"].includes(a.role),
      403,
      "officer_required",
      "An Officer or Principal must manage Clerks.",
    );
  }
  async function load(a: Access, id: string) {
    officer(a);
    const [clerk] = await db.office(a.office.id, (q) =>
      q.query("SELECT * FROM clerks WHERE id=$1", [id]),
    );
    assert(clerk, 404, "clerk_not_found", "Clerk not found.");
    return clerk;
  }
  async function decision(
    q: Query,
    clerk: any,
    input: ChatInput,
    maximum: bigint,
  ) {
    const rows = await q.query(
      "SELECT created_at,status,reserved_pico,charged_pico FROM requests WHERE actor_id=$1 AND created_at>now()-interval '7 days'",
      [clerk.id],
    );
    const now = Date.now(),
      spent = { hour: 0n, day: 0n, week: 0n };
    let calls = 0;
    for (const row of rows) {
      const amount = BigInt(
          ["inflight", "uncertain"].includes(row.status)
            ? row.reserved_pico
            : row.charged_pico || "0",
        ),
        age = now - new Date(row.created_at).getTime();
      spent.week += amount;
      if (age < 86400000) spent.day += amount;
      if (age < 3600000) {
        spent.hour += amount;
        calls++;
      }
    }
    const r = rulebookSchema.parse(clerk.rulebook);
    return evaluateClerkPolicy(
      r,
      { active: clerk.status === "active", spent },
      {
        model: input.model,
        maximum,
        maxTokens: input.maxTokens,
      },
    );
  }

  async function create(a: Access, body: unknown) {
    assert(
      a.role === "principal",
      403,
      "principal_required",
      "A Principal must authorize a Clerk allowance.",
    );
    offices.work(a);
    const input = z
      .strictObject({
        name: z.string().trim().min(1).max(80),
        job: z.string().min(1).max(20000),
        model: z.string().min(1).max(160),
        monthlyCap: rulebookSchema.shape.perRequestUsd,
        rulebook: rulebookSchema,
        scheduleMinutes: z.number().int().min(5).max(43200).optional(),
      })
      .parse(body);
    const guard = checkGuards(input.job);
    assert(
      !guard,
      400,
      "secret_detected",
      guard?.message || "Secret detected.",
    );
    assert(
      input.rulebook.models.includes(input.model),
      400,
      "model_policy",
      "The Clerk model must be in its rulebook.",
    );
    const id = uid("clerk_"),
      actor = clerkActor(id),
      delegate = await chain.delegateFor(a.office.safe, actor),
      monthly = dollars(input.monthlyCap);
    await db.office(a.office.id, (q) =>
      q.query(
        "INSERT INTO clerks(id,office_id,name,job_enc,delegate,monthly_cap_pico,rulebook,model,schedule_minutes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          a.office.id,
          input.name,
          crypto.seal(a.office.id, `clerk:${id}`, input.job),
          delegate,
          monthly.toString(),
          JSON.stringify(input.rulebook),
          input.model,
          input.scheduleMinutes || null,
          a.account.id,
        ],
      ),
    );
    const proposal = await offices.propose(
      a,
      "clerk",
      [
        {
          to: ADDRESSES.allowanceModule,
          data: encodeFunctionData({
            abi: allowanceAbi,
            functionName: "addDelegate",
            args: [delegate],
          }),
        },
        {
          to: ADDRESSES.allowanceModule,
          data: encodeFunctionData({
            abi: allowanceAbi,
            functionName: "setAllowance",
            args: [
              delegate,
              ADDRESSES.usdg,
              picoToUsdg(monthly),
              43200,
              a.snapshot!.periodStart,
            ],
          }),
        },
        {
          to: cfg.registry!,
          data: encodeFunctionData({
            abi: registryAbi,
            functionName: "setClerk",
            args: [a.office.id, actor, true],
          }),
        },
      ],
      {
        clerkId: id,
        actorId: actor,
        delegate,
        allowanceUnits: picoToUsdg(monthly).toString(),
      },
    );
    return { id, status: "pending", proposal };
  }
  async function prepare(a: Access, id: string, body: unknown) {
    const clerk = await load(a, id);
    assert(
      clerk.status === "active",
      409,
      "clerk_inactive",
      "This Clerk is not active.",
    );
    const input = body
      ? chatSchema.parse(body)
      : chatSchema.parse({
          model: clerk.model,
          messages: [
            {
              role: "user",
              content: crypto.open(a.office.id, `clerk:${id}`, clerk.job_enc),
            },
          ],
          maxTokens: clerk.rulebook.maxTokens,
        });
    const actor: Actor = {
      id,
      kind: "clerk",
      cap: BigInt(clerk.monthly_cap_pico),
      delegateActor: clerkActor(id),
    };
    const quote = await ledger.quote(a, input, actor),
      maximum = dollars(quote.maximumUsd);
    const result = await db.office(a.office.id, async (q) => {
      await q.query("SELECT * FROM office_locks FOR UPDATE");
      return decision(q, clerk, input, maximum);
    });
    if (result.decision === "deny")
      throw new ApiError(
        403,
        "rulebook_denied",
        result.reasons.map((x) => x.message).join(" "),
      );
    if (result.decision === "approval_required") {
      const approval = await db.office(a.office.id, async (q) => {
        await q.query("SELECT * FROM office_locks FOR UPDATE");
        const [existing] = await q.query(
          "SELECT id FROM approvals WHERE clerk_id=$1 AND request_hash=$2 AND status IN ('pending','approved') AND consumed_at IS NULL AND expires_at>now()",
          [id, requestHash(input)],
        );
        if (existing) return existing.id;
        const aid = uid("approval_");
        await q.query(
          "INSERT INTO approvals(id,office_id,clerk_id,request_hash,request_enc,max_cost_pico,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            aid,
            a.office.id,
            id,
            requestHash(input),
            crypto.seal(a.office.id, `approval:${aid}`, input),
            maximum.toString(),
            new Date(Date.now() + 3600000).toISOString(),
          ],
        );
        return aid;
      });
      return {
        chat: input,
        quote,
        decision: "approval_required",
        approvalId: approval,
      };
    }
    return { chat: input, quote, decision: "allow" };
  }
  async function run(a: Access, id: string, body: any) {
    const input = z
        .strictObject({
          id: z.string(),
          quoteId: z.string(),
          chat: chatSchema,
          approvalId: z.string().optional(),
        })
        .parse(body),
      clerk = await load(a, id);
    const actor: Actor = {
      id,
      kind: "clerk",
      cap: BigInt(clerk.monthly_cap_pico),
      delegateActor: clerkActor(id),
      approvalId: input.approvalId,
      async authorize(q, chat, maximum) {
        const [current] = await q.query(
          "SELECT * FROM clerks WHERE id=$1 FOR UPDATE",
          [id],
        );
        const d = await decision(q, current, chat, maximum);
        assert(
          d.decision !== "deny",
          403,
          "rulebook_denied",
          d.reasons.map((x) => x.message).join(" "),
        );
        assert(
          d.decision !== "approval_required" || input.approvalId,
          409,
          "approval_required",
          "An Officer must approve this exact request first.",
        );
      },
    };
    return ledger.request(
      a,
      { id: input.id, quoteId: input.quoteId, chat: input.chat },
      actor,
    );
  }
  return {
    create,
    load,
    prepare,
    run,
    async list(a: Access) {
      officer(a);
      return db.office(a.office.id, (q) =>
        q.query(
          "SELECT id,name,delegate,monthly_cap_pico,rulebook,model,status,schedule_minutes,next_run_at FROM clerks ORDER BY created_at",
        ),
      );
    },
    async pause(a: Access, id: string) {
      await load(a, id);
      await db.office(a.office.id, (q) =>
        q.query("UPDATE clerks SET status='paused' WHERE id=$1", [id]),
      );
      return { status: "paused" };
    },
    async resume(a: Access, id: string) {
      assert(
        a.role === "principal",
        403,
        "principal_required",
        "A Principal must resume a Clerk.",
      );
      const clerk = await load(a, id),
        s = await chain.snapshot(a.office.id, clerkActor(id));
      assert(
        s.active && s.actorActive && clerk.status === "paused",
        409,
        "clerk_inactive",
        "Restore the onchain Clerk allowance before resuming.",
      );
      await db.office(a.office.id, (q) =>
        q.query(
          "UPDATE clerks SET status='active',next_run_at=now() WHERE id=$1",
          [id],
        ),
      );
      return { status: "active" };
    },
    async revoke(a: Access, id: string) {
      await load(a, id);
      assert(
        a.role === "principal",
        403,
        "principal_required",
        "A Principal must revoke the onchain Clerk.",
      );
      await db.office(a.office.id, (q) =>
        q.query("UPDATE clerks SET status='paused' WHERE id=$1", [id]),
      );
      return offices.propose(
        a,
        "clerk_revoke",
        [
          {
            to: cfg.registry!,
            data: encodeFunctionData({
              abi: registryAbi,
              functionName: "setClerk",
              args: [a.office.id, clerkActor(id), false],
            }),
          },
        ],
        { clerkId: id },
      );
    },
    async approvals(a: Access) {
      officer(a);
      return db.office(a.office.id, async (q) =>
        (
          await q.query(
            "SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200",
          )
        ).map((row) => ({
          ...row,
          request_enc: undefined,
          chat: crypto.open(a.office.id, `approval:${row.id}`, row.request_enc),
        })),
      );
    },
    
  };
}
export type Clerks = ReturnType<typeof createClerks>;
