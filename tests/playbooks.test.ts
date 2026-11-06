import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, MEMBER } from "./fixture.ts";
import { uid } from "../server/crypto.ts";
import { releasedUpdates } from "../shared/releases.ts";
import {
  createPlaybooks,
  placeholders,
  render,
  STARTERS,
} from "../server/features/playbooks.ts";
import { policyHash, type Access } from "../server/offices.ts";

const weekly = {
  name: "Weekly update",
  description: "A short update for the team.",
  template: "Write a weekly update for {{team}}.\n\nNotes:\n{{notes}}",
  fields: [
    { name: "team", label: "Team name" },
    { name: "notes", label: "Notes", multiline: true },
  ],
  model: "test-model",
  maxPriceUsd: "0.25",
  maxTokens: 100,
};
const as = (a: Access, role: Access["role"], account = a.account): Access => ({
  ...a,
  role,
  account,
});
async function setup(released = "playbooks") {
  const r = await fixture(released),
    user = await r.login(),
    o = await r.office(user.account),
    playbooks = createPlaybooks(r);
  return { r, user, o, playbooks, officer: as(o.access, "officer") };
}

test("Playbooks: every route is hidden until the update is released", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  assert.equal(releasedUpdates("playbooks").has("playbooks"), true);
  const user = await r.login(),
    o = await r.office(user.account),
    base = `/api/offices/${o.id}/playbooks`;
  const config = await user.agent.get("/api/config");
  assert(!config.body.updates.some((u: any) => u.id === "playbooks"));
  const calls = [
    () => user.agent.get(base),
    () => user.agent.get(`${base}/playbook_x/runs`),
    ...[
      base,
      `${base}/starters`,
      `${base}/suggest-limit`,
      `${base}/playbook_x`,
      `${base}/playbook_x/archive`,
      `${base}/playbook_x/restore`,
      `${base}/playbook_x/run`,
    ].map(
      (path) => () =>
        user.agent
          .post(path)
          .set("Origin", r.cfg.origin)
          .set("X-CSRF-Token", user.csrf)
          .send({}),
    ),
  ];
  for (const call of calls) {
    const response = await call();
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "update_unavailable");
  }
});

test("Playbooks: released routes create, list and run over HTTP with a signed receipt", async (t) => {
  const r = await fixture("playbooks");
  t.after(() => r.db.close());
  const user = await r.login(),
    o = await r.office(user.account),
    base = `/api/offices/${o.id}/playbooks`,
    post = (path: string, body: unknown) =>
      user.agent
        .post(path)
        .set("Origin", r.cfg.origin)
        .set("X-CSRF-Token", user.csrf)
        .send(body as object);
  const config = await user.agent.get("/api/config");
  assert(
    config.body.updates.some((u: any) => u.id === "playbooks" && u.enabled),
  );
  const created = await post(base, weekly);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.maxPriceUsd, "0.25");
  const listed = await user.agent.get(base);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.playbooks.length, 1);
  assert.equal(listed.body.starters.length, 3);
  assert.equal(listed.body.canManage, true);
  const ran = await post(`${base}/${created.body.id}/run`, {
    id: uid("req_"),
    fields: { team: "Design", notes: "Shipped the new form." },
  });
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.equal(ran.body.status, "complete");
  assert.equal(ran.body.output, "Working answer");
  assert(await r.crypto.verify(ran.body.receipt));
  const runs = await user.agent.get(`${base}/${created.body.id}/runs`);
  assert.equal(runs.body.length, 1);
  assert.equal(runs.body[0].receiptId, ran.body.receiptId);
});

test("Playbooks: only Officers and Principals manage; members run; guests are kept out", async (t) => {
  const { r, o, playbooks, officer } = await setup();
  t.after(() => r.db.close());
  const member = as(o.access, "member"),
    guest = as(o.access, "guest");
  await assert.rejects(playbooks.create(member, weekly), {
    code: "officer_required",
  });
  await assert.rejects(playbooks.create(guest, weekly), {
    code: "officer_required",
  });
  const p = await playbooks.create(officer, weekly),
    principalMade = await playbooks.create(o.access, {
      ...weekly,
      name: "Second",
    });
  assert.equal(principalMade.name, "Second");
  await assert.rejects(playbooks.update(member, p.id, weekly), {
    code: "officer_required",
  });
  await assert.rejects(playbooks.archive(member, p.id), {
    code: "officer_required",
  });
  await assert.rejects(
    playbooks.addStarter(member, {
      starter: STARTERS[0].key,
      model: "test-model",
    }),
    { code: "officer_required" },
  );
  await assert.rejects(playbooks.list(guest), { code: "room_only" });
  await assert.rejects(playbooks.runs(guest, p.id), { code: "room_only" });
  await assert.rejects(
    playbooks.run(guest, p.id, {
      id: uid("req_"),
      fields: { team: "A", notes: "B" },
    }),
    { code: "room_only" },
  );
  const view = await playbooks.list(member);
  assert.equal(view.canManage, false);
  assert.equal(view.playbooks.length, 2);
  const result = await playbooks.run(member, p.id, {
    id: uid("req_"),
    fields: { team: "A", notes: "B" },
  });
  assert.equal(result!.status, "complete");
  // Archived Playbooks disappear for members and refuse new runs.
  await playbooks.archive(officer, p.id);
  assert.equal((await playbooks.list(member)).playbooks.length, 1);
  assert.equal((await playbooks.list(officer)).playbooks.length, 2);
  await assert.rejects(playbooks.runs(member, p.id), {
    code: "playbook_not_found",
  });
  await assert.rejects(
    playbooks.run(officer, p.id, {
      id: uid("req_"),
      fields: { team: "A", notes: "B" },
    }),
    { code: "playbook_archived" },
  );
  await playbooks.restore(officer, p.id);
  assert.equal((await playbooks.list(member)).playbooks.length, 2);
  assert.equal(r.calls(), 1);
});

test("Playbooks: templates, fields, model policy and price limits are validated", async (t) => {
  const { r, o, playbooks, officer } = await setup();
  t.after(() => r.db.close());
  assert.deepEqual(placeholders("Hi {{ name }}, {{name}} and {{x_1}}"), [
    "name",
    "x_1",
  ]);
  assert.equal(
    render("A {{a}} B {{ b }}", { a: "{{b}}", b: "2" }),
    "A {{b}} B 2",
  );
  const cases: [Record<string, unknown>, string][] = [
    [{ template: "Use {{team}} and {{other}}" }, "field_missing"],
    [{ template: "Only {{team}}" }, "field_unused"],
    [{ template: "Bad {{Team Name}} {{team}} {{notes}}" }, "template_invalid"],
    [{ template: "Open {{team}} {{notes}} {{oops" }, "template_invalid"],
    [
      {
        fields: [
          { name: "team", label: "Team" },
          { name: "team", label: "Again" },
          { name: "notes", label: "Notes" },
        ],
      },
      "field_duplicate",
    ],
    [
      { template: "Key sk-test-placeholder-0000 {{team}} {{notes}}" },
      "secret_detected",
    ],
    [{ maxPriceUsd: "5" }, "ceiling_above_policy"],
    [{ maxPriceUsd: "0" }, "amount_invalid"],
    [{ maxPriceUsd: "cheap" }, "amount_invalid"],
  ];
  for (const [change, code] of cases)
    await assert.rejects(
      playbooks.create(officer, { ...weekly, ...change }),
      { code },
      code,
    );
  for (const change of [
    { name: "" },
    { fields: [{ name: "Team", label: "Team" }] },
    { extra: true },
  ])
    await assert.rejects(playbooks.create(officer, { ...weekly, ...change }), {
      name: "ZodError",
    });
  const policy = { ...officer.office.policy, allowedModels: ["approved-model"] },
    strict: Access = {
      ...officer,
      office: { ...officer.office, policy },
      snapshot: { ...officer.snapshot!, policyHash: policyHash(policy) },
    };
  await assert.rejects(playbooks.create(strict, weekly), {
    code: "model_policy",
  });
  const p = await playbooks.create(officer, weekly);
  await assert.rejects(
    playbooks.run(o.access, p.id, {
      id: uid("req_"),
      fields: { team: "A" },
    }),
    { code: "field_required" },
  );
  await assert.rejects(
    playbooks.run(o.access, p.id, {
      id: uid("req_"),
      fields: { team: "A", notes: "  " },
    }),
    { code: "field_required" },
  );
  await assert.rejects(
    playbooks.run(o.access, p.id, {
      id: uid("req_"),
      fields: { team: "A", notes: "B", surprise: "C" },
    }),
    { code: "field_unknown" },
  );
  await assert.rejects(
    playbooks.run(o.access, p.id, {
      id: uid("req_"),
      fields: { team: "A", notes: "sk-test-placeholder-0000" },
    }),
    { code: "secret_detected" },
  );
  // A policy change after creation still stops runs on a model that is no longer allowed.
  await assert.rejects(
    playbooks.run(strict, p.id, {
      id: uid("req_"),
      fields: { team: "A", notes: "B" },
    }),
    { code: "model_policy" },
  );
  assert.equal(r.calls(), 0);
});

test("Playbooks: a quote above the price limit is refused before anything is sent", async (t) => {
  const { r, o, playbooks, officer } = await setup();
  t.after(() => r.db.close());
  // The fixture quotes every request at 0.105 USDG maximum.
  const p = await playbooks.create(officer, { ...weekly, maxPriceUsd: "0.1" });
  await assert.rejects(
    playbooks.run(o.access, p.id, {
      id: uid("req_"),
      fields: { team: "A", notes: "B" },
    }),
    (error: any) => {
      assert.equal(error.code, "over_ceiling");
      assert.equal(error.status, 402);
      assert.match(error.message, /0\.105 USDG.*0\.1 USDG/);
      return true;
    },
  );
  assert.equal(r.calls(), 0);
  const [blocked] = await playbooks.runs(o.access, p.id);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.error, "over_ceiling");
  assert.equal(blocked.quotedUsd, "0.105");
  assert.equal(blocked.receiptId, null);
  const [requests] = await r.db.office(o.id, (q) =>
    q.query("SELECT count(*)::int AS n FROM requests"),
  );
  assert.equal(requests.n, 0);
  // Raising the limit lets the same task through.
  await playbooks.update(officer, p.id, { ...weekly, maxPriceUsd: "0.2" });
  const ok = await playbooks.run(o.access, p.id, {
    id: uid("req_"),
    fields: { team: "A", notes: "B" },
  });
  assert.equal(ok!.status, "complete");
  assert.equal(ok!.ceilingUsd, "0.2");
  assert.equal(r.calls(), 1);
});

test("Playbooks: a change between quote and reservation stops the run inside the ledger", async (t) => {
  const { r, o, officer } = await setup();
  t.after(() => r.db.close());
  let racing: (() => Promise<unknown>) | null = null;
  const playbooks = createPlaybooks({
    ...r,
    ledger: {
      ...r.ledger,
      quote: async (...args: Parameters<typeof r.ledger.quote>) => {
        const quote = await r.ledger.quote(...args);
        await racing?.();
        return quote;
      },
    },
  });
  const p = await playbooks.create(officer, weekly);
  racing = () => playbooks.archive(officer, p.id);
  const id = uid("req_");
  await assert.rejects(
    playbooks.run(o.access, p.id, { id, fields: { team: "A", notes: "B" } }),
    { code: "playbook_changed" },
  );
  assert.equal(r.calls(), 0);
  await playbooks.restore(officer, p.id);
  const [failed] = await playbooks.runs(o.access, p.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "playbook_changed");
});

test("Playbooks: a run builds the prompt, bills through the ledger, signs a receipt and seals content", async (t) => {
  const { r, o, playbooks, officer } = await setup();
  t.after(() => r.db.close());
  const sent: any[] = [],
    complete = r.provider.complete;
  r.provider.complete = async (chat, ...rest) => {
    sent.push(chat);
    return complete(chat, ...rest);
  };
  const p = await playbooks.create(officer, weekly),
    id = uid("req_"),
    fields = { team: "Ops", notes: "Closed the audit {{team}} item." };
  const result = (await playbooks.run(o.access, p.id, { id, fields }))!;
  assert.equal(result.status, "complete");
  assert.equal(result.output, "Working answer");
  assert.equal(result.chargedUsd, "0.0105");
  assert.equal(result.ceilingUsd, "0.25");
  assert.deepEqual(result.inputs, fields);
  assert.equal(result.runBy.you, true);
  assert(result.receiptId?.startsWith("receipt_"));
  assert(await r.crypto.verify(result.receipt));
  assert.equal(result.receipt.payload.requestId, id);
  assert.equal(result.receipt.payload.chargedUsd, "0.0105");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].model, "test-model");
  assert.equal(sent[0].maxTokens, 100);
  assert.equal(
    sent[0].messages[0].content,
    "Write a weekly update for Ops.\n\nNotes:\nClosed the audit {{team}} item.",
  );
  // The receipt is the same one the Ledger lists.
  const ledger = await r.ledger.list(o.access);
  assert(ledger.some((x: any) => x.id === result.receiptId));
  // Retrying with the same run ID returns the same run without a second charge.
  const again = (await playbooks.run(o.access, p.id, { id, fields }))!;
  assert.equal(again.id, result.id);
  assert.equal(r.calls(), 1);
  // Templates, inputs and answers are sealed at rest.
  const rows = await r.db.office(o.id, async (q) => [
    ...(await q.query("SELECT * FROM playbooks")),
    ...(await q.query("SELECT * FROM playbook_runs")),
    ...(await q.query("SELECT * FROM requests")),
  ]);
  const raw = JSON.stringify(rows);
  for (const text of ["weekly update", "Weekly update", "Closed the audit", "Working answer"])
    assert(!raw.includes(text), text);
  // Another member sees only their own runs; Officers see everyone's but not their answers.
  const other = await r.login(MEMBER),
    member = as(o.access, "member", other.account);
  await playbooks.run(member, p.id, {
    id: uid("req_"),
    fields: { team: "Sales", notes: "Called two clients." },
  });
  const mine = await playbooks.runs(member, p.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].output, "Working answer");
  const all = await playbooks.runs(officer, p.id);
  assert.equal(all.length, 2);
  const theirs = all.find((x) => !x.runBy.you)!;
  assert.equal(theirs.output, null);
  assert.equal(theirs.inputs, null);
  assert(theirs.receipt);
  await assert.rejects(
    playbooks.run(member, p.id, { id, fields }),
    { code: "idempotency_conflict" },
  );
});

test("Playbooks: starters add in one click with a suggested price limit and run as-is", async (t) => {
  const { r, o, playbooks, officer } = await setup();
  t.after(() => r.db.close());
  assert.equal(STARTERS.length, 3);
  for (const s of STARTERS)
    assert.deepEqual(
      [...placeholders(s.template)].sort(),
      s.fields.map((f) => f.name).sort(),
    );
  const added = await Promise.all(
    STARTERS.map((s) =>
      playbooks.addStarter(officer, { starter: s.key, model: "test-model" }),
    ),
  );
  // 0.1 provider maximum + 5% platform fee, rounded up to the cent.
  for (const p of added) assert.equal(p.maxPriceUsd, "0.11");
  assert.equal(added[0].starter, "summarize_document");
  await assert.rejects(
    playbooks.addStarter(officer, { starter: "nope", model: "test-model" }),
    { code: "starter_not_found" },
  );
  const suggestion = await playbooks.suggestLimit(officer, {
    ...weekly,
    maxPriceUsd: undefined,
  });
  assert.equal(suggestion.suggestedUsd, "0.11");
  const run = await playbooks.run(o.access, added[0].id, {
    id: uid("req_"),
    fields: { document: "The team agreed to move the launch to Friday." },
  });
  assert.equal(run!.status, "complete");
});
