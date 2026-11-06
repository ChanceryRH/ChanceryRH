import { z } from "zod";
import type { FeatureContext } from "./index.ts";
import type { Access } from "../offices.ts";
import type { Actor } from "../ledger.ts";
import { uid } from "../crypto.ts";
import { ApiError, assert } from "../errors.ts";
import { checkGuards } from "../../shared/guards.ts";
import { dollars, mulBps, picoToUsdString } from "../../shared/money.ts";
// Playbooks (RELEASED_UPDATES=playbooks). Every route here must pass "playbooks" as its gate.
//
// A Playbook is an AI task an Officer approved ahead of time: a prompt template with fill-in
// fields, a model the Office policy allows, and a price ceiling per run. Running one builds the
// prompt on the server and goes through the same quote → reserve → receipt path as chat, under
// the runner's own seat budget. The ceiling is checked against the quote and again inside the
// ledger's reservation, so a run never spends more than the owner approved.

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const CENT = 10n ** 10n;
const MAX_PLAYBOOKS = 200;
const fieldSchema = z.strictObject({
  name: z.string().regex(NAME, "Use lowercase letters, numbers and underscores."),
  label: z.string().trim().min(1).max(80),
  multiline: z.boolean().default(false),
});
const definitionSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(280).default(""),
  template: z.string().trim().min(1).max(20000),
  fields: z.array(fieldSchema).max(12).default([]),
});
const playbookSchema = definitionSchema.extend({
  model: z.string().min(1).max(160),
  maxPriceUsd: z.string().max(20),
  maxTokens: z.number().int().min(64).max(8192).default(1024),
});
export type PlaybookDefinition = z.infer<typeof definitionSchema>;
type Starter = PlaybookDefinition & { key: string; maxTokens: number };

/** Built-in starters an Officer can add with one click. */
export const STARTERS: Starter[] = [
  {
    key: "summarize_document",
    name: "Summarize a document",
    description:
      "Turn a long document into a short overview, key points and next steps.",
    template:
      "Summarize the document below for a busy teammate.\n\nWrite:\n1. A two-sentence overview.\n2. Up to five key points as bullets.\n3. Any decisions, deadlines or open questions.\n\nUse plain language. Do not add facts that are not in the document.\n\nDocument:\n{{document}}",
    fields: [{ name: "document", label: "Document text", multiline: true }],
    maxTokens: 800,
  },
  {
    key: "weekly_update",
    name: "Draft a weekly team update",
    description:
      "Write a friendly weekly update from a few notes about what happened.",
    template:
      "Draft a short weekly update for the {{team}} team from these notes. Use a friendly, plain tone and three headings: Done this week, Coming up, Help needed. Keep each point to one line and do not invent work that is not in the notes.\n\nDone this week:\n{{done}}\n\nComing up:\n{{next}}\n\nBlockers or help needed:\n{{blockers}}",
    fields: [
      { name: "team", label: "Team or project name", multiline: false },
      { name: "done", label: "What got done", multiline: true },
      { name: "next", label: "What is coming up", multiline: true },
      {
        name: "blockers",
        label: "Blockers or help needed (write “none” if there are none)",
        multiline: true,
      },
    ],
    maxTokens: 800,
  },
  {
    key: "explain_transaction",
    name: "Explain a transaction in plain English",
    description:
      "Explain what an onchain transaction does, for someone new to crypto.",
    template:
      "Explain the blockchain transaction below in plain English for someone new to crypto.\n\nCover:\n- What it appears to do, in one sentence.\n- Who sends what to whom, with amounts.\n- Any approvals or permissions it grants.\n- Anything that looks risky or unusual.\n\nIf something cannot be known from these details, say so instead of guessing.\n\nTransaction details:\n{{details}}",
    fields: [
      {
        name: "details",
        label:
          "Transaction details (label hashes, for example “Tx hash: 0x…”)",
        multiline: true,
      },
    ],
    maxTokens: 1024,
  },
];

/** The field names a template uses, in order of first use. Throws on malformed placeholders. */
export function placeholders(template: string) {
  const names: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    assert(
      NAME.test(m[1]),
      400,
      "template_invalid",
      `“{{${m[1]}}}” is not a valid field. Field names use lowercase letters, numbers and underscores, like {{team_name}}.`,
    );
    if (!names.includes(m[1])) names.push(m[1]);
  }
  const rest = template.replace(PLACEHOLDER, "");
  assert(
    !rest.includes("{{") && !rest.includes("}}"),
    400,
    "template_invalid",
    "Close every field with double braces, like {{team_name}}.",
  );
  return names;
}
/** Fill a template in one pass, so values that contain braces are never expanded again. */
export function render(template: string, values: Record<string, string>) {
  return template.replace(PLACEHOLDER, (_, name: string) => values[name.trim()]);
}
function checkDefinition(definition: PlaybookDefinition) {
  const used = placeholders(definition.template),
    declared = definition.fields.map((f) => f.name);
  for (const name of declared)
    assert(
      declared.indexOf(name) === declared.lastIndexOf(name),
      400,
      "field_duplicate",
      `The field “${name}” is listed twice.`,
    );
  for (const name of used)
    assert(
      declared.includes(name),
      400,
      "field_missing",
      `The template uses {{${name}}}, but it has no field. Add a field named “${name}”.`,
    );
  for (const name of declared)
    assert(
      used.includes(name),
      400,
      "field_unused",
      `The field “${name}” is not used in the template. Add {{${name}}} or remove the field.`,
    );
  const guard = checkGuards(
    definition.name,
    definition.description,
    definition.template,
    ...definition.fields.map((f) => f.label),
  );
  assert(
    !guard,
    400,
    "secret_detected",
    guard?.message || "Remove sensitive material.",
  );
}
const usd = (pico: bigint) => picoToUsdString(pico);
function statusOf(row: any) {
  if (row.status !== "running") return row.status as "blocked" | "failed";
  if (row.request_status === "complete") return "complete";
  if (row.request_status === "refused") return "failed";
  // Nothing was reserved and the quote has long expired: the run was never sent.
  if (
    !row.request_status &&
    Date.now() - new Date(row.created_at).getTime() > 5 * 60000
  )
    return "failed";
  return "pending";
}

type Deps = Pick<
  FeatureContext,
  "db" | "crypto" | "ledger" | "offices" | "provider"
>;
export function createPlaybooks({ db, crypto, ledger, offices, provider }: Deps) {
  const manager = (a: Access) => ["principal", "officer"].includes(a.role);
  function requireMember(a: Access) {
    assert(
      a.role !== "guest",
      403,
      "room_only",
      "Guests can access their assigned Room only.",
    );
  }
  function requireManager(a: Access) {
    assert(
      manager(a),
      403,
      "officer_required",
      "An Officer or Principal must manage Playbooks.",
    );
  }
  function checkModel(a: Access, model: string) {
    const allowed: string[] = a.office.policy?.allowedModels || [];
    assert(
      !allowed.length || allowed.includes(model),
      403,
      "model_policy",
      "This model is not allowed by the Office policy.",
    );
  }
  function ceiling(a: Access, value: string) {
    let amount: bigint;
    try {
      amount = dollars(value, "20");
    } catch {
      throw new ApiError(
        400,
        "amount_invalid",
        "Enter the price limit in dollars, like 0.25.",
      );
    }
    assert(
      amount > 0n,
      400,
      "amount_invalid",
      "The price limit must be more than zero.",
    );
    const policyMax = dollars(a.office.policy.maxRequestUsd, "20");
    assert(
      amount <= policyMax,
      400,
      "ceiling_above_policy",
      `The Office allows at most ${usd(policyMax)} USDG per request. Lower the price limit.`,
    );
    return amount;
  }
  function view(a: Access, row: any) {
    const d: PlaybookDefinition = crypto.open(
      a.office.id,
      `playbook:${row.id}`,
      row.definition_enc,
    );
    return {
      id: row.id,
      ...d,
      model: row.model,
      maxTokens: row.max_tokens,
      maxPriceUsd: usd(BigInt(row.max_pico)),
      status: row.status,
      starter: row.starter,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  async function load(a: Access, id: string) {
    const [row] = await db.office(a.office.id, (q) =>
      q.query("SELECT * FROM playbooks WHERE id=$1", [id]),
    );
    assert(
      row && (row.status === "active" || manager(a)),
      404,
      "playbook_not_found",
      "Playbook not found.",
    );
    return row;
  }
  /** A ceiling that covers a typical run: generous sample inputs, the full answer length and the platform fee, rounded up to the cent. */
  async function suggest(
    a: Access,
    model: string,
    definition: PlaybookDefinition,
    maxTokens: number,
  ) {
    const sample = render(
        definition.template,
        Object.fromEntries(
          definition.fields.map((f) => [
            f.name,
            "sample ".repeat(f.multiline ? 1500 : 10).trim(),
          ]),
        ),
      ),
      estimate = await provider.estimate({
        model,
        messages: [{ role: "user", content: sample }],
        maxTokens,
        lane: "standard",
      });
    let amount =
      estimate.providerMaximum + mulBps(estimate.providerMaximum, 500);
    amount = ((amount + CENT - 1n) / CENT) * CENT;
    if (amount < CENT) amount = CENT;
    const policyMax = dollars(a.office.policy.maxRequestUsd, "20");
    return amount > policyMax ? policyMax : amount;
  }
  async function insert(
    a: Access,
    definition: PlaybookDefinition,
    model: string,
    maxTokens: number,
    maximum: bigint,
    starter: string | null,
  ) {
    const id = uid("playbook_");
    await db.office(a.office.id, async (q) => {
      const [count] = await q.query(
        "SELECT count(*)::int AS n FROM playbooks WHERE status='active'",
      );
      assert(
        count.n < MAX_PLAYBOOKS,
        409,
        "playbook_limit",
        `An Office can keep up to ${MAX_PLAYBOOKS} active Playbooks. Archive one first.`,
      );
      await q.query(
        "INSERT INTO playbooks(id,office_id,definition_enc,model,max_tokens,max_pico,starter,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)",
        [
          id,
          a.office.id,
          crypto.seal(a.office.id, `playbook:${id}`, definition),
          model,
          maxTokens,
          maximum.toString(),
          starter,
          a.account.id,
        ],
      );
    });
    return view(a, await load(a, id));
  }
  function runView(a: Access, row: any) {
    const own = row.account_id === a.account.id,
      status = statusOf(row);
    let output: string | null = null;
    if (own && row.response_enc)
      output = crypto.open(
        a.office.id,
        `request:${row.request_id}`,
        row.response_enc,
      ).content;
    const credential: string = row.credential || "";
    return {
      id: row.id,
      playbookId: row.playbook_id,
      playbookVersion: row.playbook_version,
      requestId: row.request_id,
      status,
      runBy: {
        you: own,
        label: own
          ? "You"
          : credential.startsWith("wallet:")
            ? credential.slice(7)
            : "Passkey seat",
        role: row.seat_role || null,
      },
      createdAt: row.created_at,
      completedAt: row.completed_at || null,
      ceilingUsd: usd(BigInt(row.ceiling_pico)),
      quotedUsd:
        row.quoted_pico === null ? null : usd(BigInt(row.quoted_pico)),
      chargedUsd:
        row.charged_pico === null || row.charged_pico === undefined
          ? null
          : usd(BigInt(row.charged_pico)),
      receiptId: row.receipt_id || null,
      receipt: own || manager(a) ? row.receipt || null : null,
      error:
        row.error_code ||
        row.request_error ||
        (status === "failed" && !row.request_status ? "not_sent" : null),
      inputs: own
        ? crypto.open(a.office.id, `playbook-run:${row.id}`, row.inputs_enc)
        : null,
      output,
      retained: row.lane !== "zero_retention",
    };
  }
  const RUNS =
    "SELECT pr.*,r.status AS request_status,r.charged_pico,r.receipt_id,r.response_enc,r.lane,r.error_code AS request_error,r.completed_at,s.credential,s.role AS seat_role,rc.envelope AS receipt FROM playbook_runs pr LEFT JOIN requests r ON r.id=pr.request_id LEFT JOIN seats s ON s.id=pr.seat_id LEFT JOIN receipts rc ON rc.id=r.receipt_id";
  async function oneRun(a: Access, requestId: string) {
    const [row] = await db.office(a.office.id, (q) =>
      q.query(`${RUNS} WHERE pr.request_id=$1`, [requestId]),
    );
    return row ? runView(a, row) : null;
  }

  async function list(a: Access) {
    requireMember(a);
    const rows = await db.office(a.office.id, (q) =>
      q.query(
        "SELECT * FROM playbooks WHERE status='active' OR $1::boolean ORDER BY status, updated_at DESC LIMIT 500",
        [manager(a)],
      ),
    );
    return {
      playbooks: rows.map((row) => view(a, row)),
      starters: STARTERS.map(({ key, name, description }) => ({
        key,
        name,
        description,
      })),
      canManage: manager(a),
      maxRequestUsd: a.office.policy.maxRequestUsd,
    };
  }
  async function create(a: Access, body: unknown) {
    requireManager(a);
    const input = playbookSchema.parse(body),
      { model, maxPriceUsd, maxTokens, ...definition } = input;
    checkDefinition(definition);
    checkModel(a, model);
    return insert(
      a,
      definition,
      model,
      maxTokens,
      ceiling(a, maxPriceUsd),
      null,
    );
  }
  async function addStarter(a: Access, body: unknown) {
    requireManager(a);
    const input = z
        .strictObject({
          starter: z.string().max(80),
          model: z.string().min(1).max(160),
        })
        .parse(body),
      starter = STARTERS.find((s) => s.key === input.starter);
    assert(starter, 404, "starter_not_found", "Starter not found.");
    checkModel(a, input.model);
    const { key, maxTokens, ...definition } = starter;
    return insert(
      a,
      definition,
      input.model,
      maxTokens,
      await suggest(a, input.model, definition, maxTokens),
      key,
    );
  }
  async function suggestLimit(a: Access, body: unknown) {
    requireManager(a);
    const input = playbookSchema
        .omit({ maxPriceUsd: true })
        .extend({ maxPriceUsd: z.string().max(20).optional() })
        .parse(body),
      { model, maxPriceUsd: _, maxTokens, ...definition } = input;
    checkDefinition(definition);
    checkModel(a, model);
    return {
      suggestedUsd: usd(await suggest(a, model, definition, maxTokens)),
    };
  }
  async function update(a: Access, id: string, body: unknown) {
    requireManager(a);
    const input = playbookSchema.parse(body),
      { model, maxPriceUsd, maxTokens, ...definition } = input;
    checkDefinition(definition);
    checkModel(a, model);
    const maximum = ceiling(a, maxPriceUsd);
    await db.office(a.office.id, async (q) => {
      const [row] = await q.query(
        "SELECT id FROM playbooks WHERE id=$1 FOR UPDATE",
        [id],
      );
      assert(row, 404, "playbook_not_found", "Playbook not found.");
      await q.query(
        "UPDATE playbooks SET definition_enc=$1,model=$2,max_tokens=$3,max_pico=$4,version=version+1,updated_by=$5,updated_at=now() WHERE id=$6",
        [
          crypto.seal(a.office.id, `playbook:${id}`, definition),
          model,
          maxTokens,
          maximum.toString(),
          a.account.id,
          id,
        ],
      );
    });
    return view(a, await load(a, id));
  }
  async function setStatus(
    a: Access,
    id: string,
    status: "active" | "archived",
  ) {
    requireManager(a);
    await db.office(a.office.id, async (q) => {
      const [row] = await q.query(
        "UPDATE playbooks SET status=$1,updated_by=$2,updated_at=now() WHERE id=$3 RETURNING id",
        [status, a.account.id, id],
      );
      assert(row, 404, "playbook_not_found", "Playbook not found.");
    });
    return view(a, await load(a, id));
  }
  async function runs(a: Access, id: string) {
    requireMember(a);
    await load(a, id);
    const rows = await db.office(a.office.id, (q) =>
      q.query(
        `${RUNS} WHERE pr.playbook_id=$1 AND ($2::boolean OR pr.account_id=$3) ORDER BY pr.created_at DESC LIMIT 25`,
        [id, manager(a), a.account.id],
      ),
    );
    return rows.map((row) => runView(a, row));
  }
  async function run(a: Access, id: string, body: unknown) {
    requireMember(a);
    offices.work(a);
    const input = z
      .strictObject({
        id: z.string().regex(/^[a-zA-Z0-9_-]{16,100}$/),
        fields: z.record(z.string().max(40), z.string().max(20000)).default({}),
      })
      .parse(body);
    // Retrying the same run ID returns that run instead of spending twice.
    const prior = await db.office(a.office.id, async (q) => {
      const [run] = await q.query(
        "SELECT account_id,playbook_id FROM playbook_runs WHERE request_id=$1",
        [input.id],
      );
      const [request] = await q.query("SELECT id FROM requests WHERE id=$1", [
        input.id,
      ]);
      return { run, request };
    });
    if (prior.run) {
      assert(
        prior.run.account_id === a.account.id && prior.run.playbook_id === id,
        409,
        "idempotency_conflict",
        "This run ID is already used.",
      );
      return oneRun(a, input.id);
    }
    assert(
      !prior.request,
      409,
      "idempotency_conflict",
      "This run ID is already used.",
    );
    const row = await load(a, id);
    assert(
      row.status === "active",
      409,
      "playbook_archived",
      "This Playbook is archived. Ask an Officer to restore it.",
    );
    const playbook = view(a, row),
      values: Record<string, string> = {};
    for (const key of Object.keys(input.fields))
      assert(
        playbook.fields.some((f) => f.name === key),
        400,
        "field_unknown",
        `This Playbook has no field named “${key}”.`,
      );
    for (const f of playbook.fields) {
      const value = (input.fields[f.name] || "").trim();
      assert(value, 400, "field_required", `Fill in “${f.label}”.`);
      values[f.name] = value;
    }
    const prompt = render(playbook.template, values);
    assert(
      prompt.length <= 60000,
      400,
      "input_too_long",
      "What you entered is too long. Shorten it and try again.",
    );
    const guard = checkGuards(prompt);
    assert(
      !guard,
      400,
      "secret_detected",
      guard?.message || "Remove sensitive material before running.",
    );
    const chat = {
        model: playbook.model,
        messages: [{ role: "user" as const, content: prompt }],
        maxTokens: playbook.maxTokens,
        lane: (a.office.policy.allowedLanes.includes("standard")
          ? "standard"
          : "zero_retention") as "standard" | "zero_retention",
      },
      limit = BigInt(row.max_pico);
    // Same quote the chat path uses: policy, model, guards and price checks all apply.
    const quote = await ledger.quote(a, chat),
      maximum = dollars(quote.maximumUsd, "1000");
    const runId = uid("pbrun_"),
      record = (status: string, error: string | null) =>
        db.office(a.office.id, (q) =>
          q.query(
            "INSERT INTO playbook_runs(id,office_id,playbook_id,playbook_version,request_id,account_id,seat_id,status,ceiling_pico,quoted_pico,inputs_enc,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(office_id,request_id) DO NOTHING RETURNING id",
            [
              runId,
              a.office.id,
              id,
              row.version,
              input.id,
              a.account.id,
              a.seat.id,
              status,
              limit.toString(),
              maximum.toString(),
              crypto.seal(a.office.id, `playbook-run:${runId}`, values),
              error,
            ],
          ),
        );
    if (maximum > limit) {
      await record("blocked", "over_ceiling");
      throw new ApiError(
        402,
        "over_ceiling",
        `This run could cost up to ${usd(maximum)} USDG, above this Playbook’s limit of ${usd(limit)} USDG. Shorten what you entered or ask an Officer to raise the limit.`,
      );
    }
    const [created] = await record("running", null);
    if (!created) return oneRun(a, input.id);
    // Checked again while the ledger holds the Office lock, so an edit or archive mid-run can't widen the spend.
    const actor: Actor = {
      ...ledger.actorFor(a),
      async authorize(q, _chat, reserved) {
        const [current] = await q.query(
          "SELECT status,version,max_pico FROM playbooks WHERE id=$1 FOR UPDATE",
          [id],
        );
        assert(
          current?.status === "active" && current.version === row.version,
          409,
          "playbook_changed",
          "This Playbook changed while you were running it. Try again.",
        );
        assert(
          reserved <= BigInt(current.max_pico),
          402,
          "over_ceiling",
          "This run would cost more than the Playbook’s price limit.",
        );
      },
    };
    let content: string | null = null;
    try {
      const result: any = await ledger.request(
        a,
        { id: input.id, quoteId: quote.id, chat },
        actor,
      );
      content = result.content ?? null;
    } catch (error) {
      if (error instanceof ApiError)
        await db.office(a.office.id, (q) =>
          q.query(
            "UPDATE playbook_runs SET status='failed',error_code=$1 WHERE id=$2 AND NOT EXISTS(SELECT 1 FROM requests WHERE id=$3)",
            [error.code, runId, input.id],
          ),
        );
      throw error;
    }
    const result = (await oneRun(a, input.id))!;
    // Zero-retention answers are delivered once and never stored.
    return { ...result, output: result.output ?? content };
  }
  return {
    list,
    create,
    addStarter,
    suggestLimit,
    update,
    archive: (a: Access, id: string) => setStatus(a, id, "archived"),
    restore: (a: Access, id: string) => setStatus(a, id, "active"),
    runs,
    run,
  };
}
export type Playbooks = ReturnType<typeof createPlaybooks>;

export function register(ctx: FeatureContext) {
  const playbooks = createPlaybooks(ctx),
    { route, param } = ctx;
  route("get", "/playbooks", (a) => playbooks.list(a), "playbooks");
  route("post", "/playbooks", (a, r) => playbooks.create(a, r.body), "playbooks");
  route(
    "post",
    "/playbooks/starters",
    (a, r) => playbooks.addStarter(a, r.body),
    "playbooks",
  );
  route(
    "post",
    "/playbooks/suggest-limit",
    (a, r) => playbooks.suggestLimit(a, r.body),
    "playbooks",
  );
  route(
    "post",
    "/playbooks/:id",
    (a, r) => playbooks.update(a, param(r, "id"), r.body),
    "playbooks",
  );
  route(
    "post",
    "/playbooks/:id/archive",
    (a, r) => playbooks.archive(a, param(r, "id")),
    "playbooks",
  );
  route(
    "post",
    "/playbooks/:id/restore",
    (a, r) => playbooks.restore(a, param(r, "id")),
    "playbooks",
  );
  route(
    "get",
    "/playbooks/:id/runs",
    (a, r) => playbooks.runs(a, param(r, "id")),
    "playbooks",
  );
  route(
    "post",
    "/playbooks/:id/run",
    (a, r) => playbooks.run(a, param(r, "id"), r.body),
    "playbooks",
  );
}
