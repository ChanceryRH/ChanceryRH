import { z } from "zod";
import { checkGuards } from "../../shared/guards.ts";
import { dollars, picoToUsdString } from "../../shared/money.ts";
import { uid } from "../crypto.ts";
import { ApiError, assert } from "../errors.ts";
import { requestHash } from "../ledger.ts";
import { chatSchema } from "../provider.ts";
import type { Access } from "../offices.ts";
import type { FeatureContext } from "./index.ts";
// Side by Side (RELEASED_UPDATES=side_by_side). Every route here must pass "side_by_side" as its gate.
// Each column is an ordinary billed request: quote, approve, reserve, run and sign a receipt through the Ledger.

type Problem = { code: string; message: string };
type Column = {
  model: string;
  quoteId: string;
  requestId: string;
  maximumUsd: string;
  startedAt: string | null;
  durationMs: number | null;
  error: Problem | null;
};
type Body = {
  prompt: string;
  maxTokens: number;
  totalMaximumUsd: string;
  columns: Column[];
  favourite: string | null;
};
const prompt = z.string().trim().min(1).max(20000),
  models = z.array(z.string().min(1).max(160)).max(10),
  maxTokens = z.number().int().min(1).max(8192).default(1024);
const quoteSchema = z.strictObject({ prompt, models, maxTokens });
const createSchema = z.strictObject({
  prompt,
  models,
  maxTokens,
  quoteIds: z.array(z.string().max(100)).max(10),
  approvedMaximumUsd: z.string().max(40),
});
const providerMessages: Record<string, string> = {
  refused:
    "The model provider turned this request down. You were not charged for it.",
  uncertain:
    "The provider did not confirm this result. Its held amount stays reserved until Chancery reconciles it.",
};
const day = () => Math.floor(Date.now() / 86400000);

export function createSideBySide(
  ctx: Pick<FeatureContext, "db" | "crypto" | "chain" | "offices" | "ledger">,
) {
  const { db, crypto, chain, offices, ledger } = ctx;
  const seal = (a: Access, id: string, body: Body) =>
    crypto.seal(a.office.id, `comparison:${id}`, body);
  const open = (a: Access, row: any): Body =>
    crypto.open(a.office.id, `comparison:${row.id}`, row.body_enc);
  const chatFor = (text: string, model: string, tokens: number) =>
    chatSchema.parse({
      model,
      messages: [{ role: "user", content: text }],
      maxTokens: tokens,
      lane: "standard",
    });

  function member(a: Access) {
    assert(
      a.role !== "guest",
      403,
      "role_required",
      "Guests cannot use Side by Side.",
    );
  }
  function prepare(a: Access, input: { prompt: string; models: string[] }) {
    member(a);
    offices.work(a);
    assert(
      a.office.policy.allowedLanes.includes("standard"),
      403,
      "lane_policy",
      "Side by Side saves its answers, so it needs standard processing. This Office's policy allows zero retention only.",
    );
    const guard = checkGuards(input.prompt);
    assert(
      !guard,
      400,
      "secret_detected",
      guard?.message || "Remove sensitive material before sending.",
    );
    assert(
      input.models.length >= 2 && input.models.length <= 3,
      400,
      "model_count",
      "Pick 2 or 3 models to compare.",
    );
    assert(
      new Set(input.models).size === input.models.length,
      400,
      "model_duplicate",
      "Pick a different model for each column.",
    );
    const allowed: string[] = a.office.policy.allowedModels || [];
    for (const model of input.models)
      assert(
        !allowed.length || allowed.includes(model),
        403,
        "model_policy",
        `${model} is not allowed by the Office policy.`,
      );
  }

  /** Would the combined maximum fit every budget right now? Explained before anything runs. */
  async function headroom(a: Access, total: bigint): Promise<Problem | null> {
    const actor = ledger.actorFor(a);
    try {
      const snapshot = await chain.snapshot(a.office.id, actor.delegateActor);
      await db.office(a.office.id, async (q) => {
        const [fee] = await q.query(
          "SELECT receipt_id FROM seat_charges WHERE seat_id=$1 AND day=$2",
          [a.seat.id, day()],
        );
        assert(
          fee,
          402,
          "seat_fee_due",
          "Today's seat fee has not been reserved yet. Make sure the Office has enough USDG; Chancery retries automatically.",
        );
        await ledger.budget(q, snapshot, actor, total);
      });
      return null;
    } catch (error) {
      if (error instanceof ApiError)
        return { code: error.code, message: error.message };
      throw error;
    }
  }

  async function quote(a: Access, body: unknown) {
    const input = quoteSchema.parse(body);
    prepare(a, input);
    const rows = await Promise.all(
      input.models.map(async (model) => {
        try {
          const q = await ledger.quote(
            a,
            chatFor(input.prompt, model, input.maxTokens),
          );
          return {
            model,
            quote: {
              id: q.id,
              maximumUsd: q.maximumUsd,
              expiresAt: q.expiresAt,
            },
            problem: null as Problem | null,
          };
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          return {
            model,
            quote: null,
            problem: { code: error.code, message: error.message },
          };
        }
      }),
    );
    const total = rows.reduce(
      (n, r) => n + (r.quote ? dollars(r.quote.maximumUsd, "1000000") : 0n),
      0n,
    );
    const problem: Problem | null = rows.some((r) => !r.quote)
      ? {
          code: "quote_unavailable",
          message:
            "At least one model can't take this request. Pick another model or a shorter answer length.",
        }
      : await headroom(a, total);
    return {
      models: rows,
      totalMaximumUsd: picoToUsdString(total),
      expiresAt:
        rows
          .map((r) => r.quote?.expiresAt)
          .filter(Boolean)
          .sort()[0] || null,
      ready: !problem,
      problem,
    };
  }

  async function view(a: Access, id: string, body: Body, createdAt: string) {
    return {
      id,
      prompt: body.prompt,
      maxTokens: body.maxTokens,
      totalMaximumUsd: body.totalMaximumUsd,
      favourite: body.favourite,
      createdAt,
      columns: await Promise.all(
        body.columns.map((c, position) => column(a, c, position)),
      ),
    };
  }

  async function column(a: Access, c: Column, position: number, result?: any) {
    let status = result;
    if (!status && !c.error)
      status = await ledger.status(a, c.requestId).catch((error) => {
        if (error instanceof ApiError && error.code === "request_not_found")
          return null;
        throw error;
      });
    const usage = status?.receipt?.payload?.usage,
      input = Number(usage?.prompt_tokens ?? usage?.input_tokens),
      output = Number(usage?.completion_tokens ?? usage?.output_tokens);
    return {
      position,
      model: c.model,
      requestId: c.requestId,
      maximumUsd: c.maximumUsd,
      state: status
        ? (status.status as string)
        : c.error
          ? "blocked"
          : c.startedAt
            ? "running"
            : "waiting",
      content: status?.content ?? null,
      chargedUsd: status?.chargedUsd ?? null,
      receiptId: status?.receipt?.payload?.id ?? null,
      receipt: status?.receipt ?? null,
      durationMs: c.durationMs,
      tokens:
        Number.isFinite(input) || Number.isFinite(output)
          ? {
              input: Number.isFinite(input) ? input : null,
              output: Number.isFinite(output) ? output : null,
            }
          : null,
      error:
        c.error ||
        (status?.error
          ? {
              code: status.error,
              message:
                providerMessages[status.status] ||
                "This request did not complete.",
            }
          : status?.status === "uncertain" && !status.content
            ? { code: "uncertain", message: providerMessages.uncertain }
            : null),
    };
  }

  async function create(a: Access, body: unknown) {
    const input = createSchema.parse(body);
    prepare(a, input);
    assert(
      input.quoteIds.length === input.models.length,
      400,
      "quote_mismatch",
      "Get a price for every model before comparing.",
    );
    let approved = 0n;
    try {
      approved = dollars(input.approvedMaximumUsd, "1000000");
    } catch {
      assert(false, 400, "amount_invalid", "The approved amount is invalid.");
    }
    const quoted = await db.office(a.office.id, async (q) => {
      const out: { model: string; quoteId: string; maximum: bigint }[] = [];
      for (const [i, model] of input.models.entries()) {
        const [row] = await q.query("SELECT * FROM quotes WHERE id=$1", [
          input.quoteIds[i],
        ]);
        assert(
          row &&
            row.account_id === a.account.id &&
            row.envelope.payload.actorId === a.seat.id &&
            row.envelope.payload.model === model &&
            row.request_hash ===
              requestHash(chatFor(input.prompt, model, input.maxTokens)) &&
            !row.consumed_by &&
            new Date(row.expires_at).getTime() > Date.now(),
          409,
          "quote_invalid",
          "These prices expired or no longer match the question. Get fresh prices and try again.",
        );
        out.push({ model, quoteId: row.id, maximum: BigInt(row.maximum_pico) });
      }
      return out;
    });
    const total = quoted.reduce((n, x) => n + x.maximum, 0n);
    assert(
      total <= approved,
      409,
      "approval_too_low",
      `These answers could cost up to ${picoToUsdString(total)} USDG, more than you approved. Review the price again.`,
    );
    const problem = await headroom(a, total);
    if (problem) throw new ApiError(402, problem.code, problem.message);
    const id = uid("comparison_"),
      record: Body = {
        prompt: input.prompt,
        maxTokens: input.maxTokens,
        totalMaximumUsd: picoToUsdString(total),
        favourite: null,
        columns: quoted.map((x) => ({
          model: x.model,
          quoteId: x.quoteId,
          requestId: uid("req_"),
          maximumUsd: picoToUsdString(x.maximum),
          startedAt: null,
          durationMs: null,
          error: null,
        })),
      };
    const [row] = await db.office(a.office.id, (q) =>
      q.query(
        "INSERT INTO comparisons(id,office_id,account_id,body_enc) VALUES($1,$2,$3,$4) RETURNING created_at",
        [id, a.office.id, a.account.id, seal(a, id, record)],
      ),
    );
    return view(a, id, record, row.created_at);
  }

  /** Lock this account's comparison, let fn change its sealed body, and save it. */
  async function change<T>(
    a: Access,
    id: string,
    fn: (body: Body) => T,
  ): Promise<{ body: Body; createdAt: string; value: T }> {
    return db.office(a.office.id, async (q) => {
      const [row] = await q.query(
        "SELECT * FROM comparisons WHERE id=$1 AND account_id=$2 FOR UPDATE",
        [id, a.account.id],
      );
      assert(row, 404, "comparison_not_found", "Comparison not found.");
      const body = open(a, row),
        value = fn(body);
      await q.query(
        "UPDATE comparisons SET body_enc=$1,updated_at=now() WHERE id=$2",
        [seal(a, id, body), id],
      );
      return { body, createdAt: row.created_at, value };
    });
  }

  async function run(a: Access, id: string, position: number) {
    member(a);
    const started = await change(a, id, (body) => {
      const c = body.columns[position];
      assert(c, 404, "column_not_found", "Column not found.");
      if (c.startedAt) return false;
      c.startedAt = new Date().toISOString();
      return true;
    });
    const c = started.body.columns[position];
    // A column runs once. Repeat calls report its current state.
    if (!started.value) return column(a, c, position);
    const begin = Date.now();
    let result: any = null,
      error: Problem | null = null;
    try {
      result = await ledger.request(a, {
        id: c.requestId,
        quoteId: c.quoteId,
        chat: chatFor(started.body.prompt, c.model, started.body.maxTokens),
      });
    } catch (e) {
      // Refused before anything was sent, so nothing was reserved or charged.
      if (!(e instanceof ApiError)) throw e;
      error = { code: e.code, message: e.message };
    }
    const durationMs = Date.now() - begin;
    const saved = await change(a, id, (body) => {
      Object.assign(body.columns[position], { durationMs, error });
    });
    return column(a, saved.body.columns[position], position, result);
  }

  async function list(a: Access) {
    member(a);
    return db.office(a.office.id, async (q) =>
      (
        await q.query(
          "SELECT * FROM comparisons WHERE account_id=$1 ORDER BY created_at DESC LIMIT 30",
          [a.account.id],
        )
      ).map((row) => {
        const body = open(a, row);
        return {
          id: row.id,
          title: body.prompt.slice(0, 80),
          models: body.columns.map((c) => c.model),
          favourite:
            body.columns.find((c) => c.requestId === body.favourite)?.model ||
            null,
          createdAt: row.created_at,
        };
      }),
    );
  }

  async function get(a: Access, id: string) {
    member(a);
    const row = await db.office(a.office.id, async (q) => {
      const [found] = await q.query(
        "SELECT * FROM comparisons WHERE id=$1 AND account_id=$2",
        [id, a.account.id],
      );
      assert(found, 404, "comparison_not_found", "Comparison not found.");
      return found;
    });
    return view(a, id, open(a, row), row.created_at);
  }

  async function favourite(a: Access, id: string, body: unknown) {
    member(a);
    const input = z
      .strictObject({ requestId: z.string().max(100).nullable() })
      .parse(body);
    await change(a, id, (record) => {
      assert(
        input.requestId === null ||
          record.columns.some((c) => c.requestId === input.requestId),
        400,
        "column_not_found",
        "Pick one of this comparison's answers.",
      );
      record.favourite = input.requestId;
    });
    return { favourite: input.requestId };
  }

  async function remove(a: Access, id: string) {
    member(a);
    await db.office(a.office.id, async (q) => {
      const [row] = await q.query(
        "SELECT * FROM comparisons WHERE id=$1 AND account_id=$2 FOR UPDATE",
        [id, a.account.id],
      );
      assert(row, 404, "comparison_not_found", "Comparison not found.");
      // Forget the stored answers too. Billing receipts stay in the Ledger.
      await q.query(
        "UPDATE requests SET response_enc=NULL WHERE id=ANY($1::text[]) AND account_id=$2",
        [open(a, row).columns.map((c) => c.requestId), a.account.id],
      );
      await q.query("DELETE FROM comparisons WHERE id=$1", [id]);
    });
    return { deleted: true, billingReceiptsRetained: true };
  }

  return { quote, create, run, list, get, favourite, remove };
}

export function register(ctx: FeatureContext) {
  const compare = createSideBySide(ctx),
    gate = "side_by_side" as const,
    id = (req: Parameters<FeatureContext["param"]>[0]) => {
      const value = ctx.param(req, "id");
      assert(
        /^comparison_[0-9a-f]{32}$/.test(value),
        404,
        "comparison_not_found",
        "Comparison not found.",
      );
      return value;
    };
  ctx.route(
    "post",
    "/comparisons/quotes",
    (a, r) => compare.quote(a, r.body),
    gate,
  );
  ctx.route("post", "/comparisons", (a, r) => compare.create(a, r.body), gate);
  ctx.route("get", "/comparisons", (a) => compare.list(a), gate);
  ctx.route("get", "/comparisons/:id", (a, r) => compare.get(a, id(r)), gate);
  ctx.route(
    "post",
    "/comparisons/:id/columns/:position/run",
    (a, r) => {
      const position = ctx.param(r, "position");
      assert(
        /^[0-2]$/.test(position),
        404,
        "column_not_found",
        "Column not found.",
      );
      return compare.run(a, id(r), Number(position));
    },
    gate,
  );
  ctx.route(
    "post",
    "/comparisons/:id/favourite",
    (a, r) => compare.favourite(a, id(r), r.body),
    gate,
  );
  ctx.route(
    "delete",
    "/comparisons/:id",
    (a, r) => compare.remove(a, id(r)),
    gate,
  );
}
