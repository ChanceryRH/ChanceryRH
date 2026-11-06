import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { fixture, MEMBER } from "./fixture.ts";
import { seatLeaf } from "../server/chain.ts";
import { uid, MerkleTree } from "../server/crypto.ts";
import { dollars } from "../shared/money.ts";
import { releasedUpdates } from "../shared/releases.ts";
import { FILE_LIMITS } from "../server/features/office-files.ts";
const GUEST = privateKeyToAccount(`0x${"33".repeat(32)}`);
const handbook =
  "# Team handbook\n\nThe sample team meets every Tuesday at 10:00.\nExpense reports are due on the 5th of each month.\n";
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Session = Awaited<ReturnType<Fixture["login"]>>;
const send = (r: Fixture, user: Session) => ({
  get: (path: string) => user.agent.get(path),
  post: (path: string, body: unknown) =>
    user.agent
      .post(path)
      .set("Origin", r.cfg.origin)
      .set("X-CSRF-Token", user.csrf)
      .send(body as object),
  delete: (path: string) =>
    user.agent
      .delete(path)
      .set("Origin", r.cfg.origin)
      .set("X-CSRF-Token", user.csrf),
});
/** Add an approved non-owner seat and move the Safe-approved seat root to include it. */
async function seat(
  r: Fixture,
  officeId: string,
  user: Session,
  role: "officer" | "member" | "guest",
) {
  const cap = dollars("10").toString(),
    id = uid("seat_"),
    expires = role === "guest" ? new Date(Date.now() + 86400000).toISOString() : null,
    leaf = seatLeaf(user.account.credential, role, cap, expires);
  await r.db.office(officeId, async (q) => {
    await q.query(
      "INSERT INTO seats(id,office_id,account_id,credential,role,monthly_cap_pico,expires_at,status,leaf) VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8)",
      [id, officeId, user.account.id, user.account.credential, role, cap, expires, leaf],
    );
    await q.query(
      "INSERT INTO seat_charges(office_id,seat_id,day,receipt_id) VALUES($1,$2,$3,$4)",
      [officeId, id, Math.floor(Date.now() / 86400000), "fixture_prepaid"],
    );
    const seats = await q.query("SELECT credential,leaf FROM seats WHERE status='active'"),
      root = new MerkleTree(
        seats
          .sort((x, y) => (x.credential < y.credential ? -1 : x.credential > y.credential ? 1 : 0))
          .map((s) => s.leaf),
      ).root;
    await q.query("UPDATE seats SET approved_root=$1 WHERE status='active'", [root]);
    r.snapshots.get(officeId)!.seatRoot = root;
  });
}
const ask = (fileIds: string[], question = "When does the team meet?") => ({
  fileIds,
  question,
  model: "test-model",
  maxTokens: 100,
  lane: "standard",
});
test("Office Files is a known, unlisted update", () => {
  assert.ok(releasedUpdates("office_files").has("office_files"));
});
test("Office Files: every route is hidden until the update is released", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const owner = await r.login(),
    o = await r.office(owner.account),
    http = send(r, owner),
    base = `/api/offices/${o.id}`,
    file = `file_${"a".repeat(32)}`;
  const config = await owner.agent.get("/api/config");
  assert(!config.body.updates.some((u: any) => u.id === "office_files"));
  for (const response of [
    await http.get(`${base}/files`),
    await http.post(`${base}/files`, { name: "notes.md", content: handbook }),
    await http.get(`${base}/files/${file}`),
    await http.post(`${base}/files/${file}/rename`, { name: "other.md" }),
    await http.delete(`${base}/files/${file}`),
    await http.get(`${base}/file-questions`),
    await http.post(`${base}/file-questions/quote`, ask([file])),
    await http.post(`${base}/file-questions`, { ...ask([file]), id: uid("req_"), quoteId: "quote_x" }),
    await http.delete(`${base}/file-questions/filequestion_${"b".repeat(32)}`),
  ]) {
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "update_unavailable");
  }
});
test("Office Files: officers manage files, members read and ask, guests are refused", async (t) => {
  const r = await fixture("office_files");
  t.after(() => r.db.close());
  const owner = await r.login(),
    member = await r.login(MEMBER),
    guest = await r.login(GUEST),
    o = await r.office(owner.account),
    base = `/api/offices/${o.id}`;
  await seat(r, o.id, member, "member");
  await seat(r, o.id, guest, "guest");
  const principal = send(r, owner),
    reader = send(r, member),
    visitor = send(r, guest);
  const listed = await principal.get(`${base}/files`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.canEdit, true);
  const created = await principal.post(`${base}/files`, { name: "handbook.md", content: handbook });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, "handbook.md");
  assert.equal(created.body.sizeBytes, Buffer.byteLength(handbook));
  const id = created.body.id;
  // Members can list, preview and see history, but cannot change files.
  const memberList = await reader.get(`${base}/files`);
  assert.equal(memberList.status, 200);
  assert.equal(memberList.body.canEdit, false);
  assert.equal(memberList.body.files[0].uploadedByYou, false);
  assert.equal(memberList.body.files[0].uploaderRole, "principal");
  assert.equal((await reader.get(`${base}/files/${id}`)).body.content, handbook);
  assert.equal((await reader.get(`${base}/file-questions`)).status, 200);
  for (const response of [
    await reader.post(`${base}/files`, { name: "member.md", content: "Hello" }),
    await reader.post(`${base}/files/${id}/rename`, { name: "mine.md" }),
    await reader.delete(`${base}/files/${id}`),
  ]) {
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "officer_required");
  }
  // Guests have no access to files or questions.
  for (const response of [
    await visitor.get(`${base}/files`),
    await visitor.get(`${base}/files/${id}`),
    await visitor.get(`${base}/file-questions`),
    await visitor.post(`${base}/file-questions/quote`, ask([id])),
    await visitor.post(`${base}/files`, { name: "guest.md", content: "Hello" }),
  ]) {
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "role_required");
  }
  // Members can ask, through the normal quote and receipt path.
  const quoted = await reader.post(`${base}/file-questions/quote`, ask([id]));
  assert.equal(quoted.status, 200);
  const answered = await reader.post(`${base}/file-questions`, {
    ...ask([id]),
    id: uid("req_"),
    quoteId: quoted.body.quote.id,
  });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.status, "complete");
  // Officers rename and delete; names stay unique and typed.
  assert.equal(
    (await principal.post(`${base}/files/${id}/rename`, { name: "team-handbook.md" })).body.name,
    "team-handbook.md",
  );
  await principal.post(`${base}/files`, { name: "budget.csv", content: "item,amount\nsnacks,12\n" });
  const clash = await principal.post(`${base}/files/${id}/rename`, { name: "Budget.CSV" });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, "name_taken");
  const pdf = await principal.post(`${base}/files`, { name: "report.pdf", content: "%PDF-1.7" });
  assert.equal(pdf.status, 415);
  assert.equal(pdf.body.error.code, "file_type");
  const binary = await principal.post(`${base}/files`, { name: "data.txt", content: "a\u0000b" });
  assert.equal(binary.status, 415);
  assert.equal((await principal.delete(`${base}/files/${id}`)).body.deleted, true);
  assert.equal((await principal.get(`${base}/files/${id}`)).status, 404);
});
test("Office Files: per-file, per-Office count and storage limits are enforced on the server", async (t) => {
  const r = await fixture("office_files");
  t.after(() => r.db.close());
  const owner = await r.login(),
    o = await r.office(owner.account),
    http = send(r, owner),
    base = `/api/offices/${o.id}`;
  const big = await http.post(`${base}/files`, {
    name: "big.txt",
    content: "x".repeat(FILE_LIMITS.fileBytes + 1),
  });
  assert.equal(big.status, 413);
  assert.equal(big.body.error.code, "file_too_large");
  // Multi-byte characters count by their UTF-8 size, not their length.
  const wide = await http.post(`${base}/files`, {
    name: "wide.txt",
    content: "é".repeat(FILE_LIMITS.fileBytes / 2 + 1),
  });
  assert.equal(wide.body.error.code, "file_too_large");
  const nearly = "y".repeat(FILE_LIMITS.fileBytes);
  for (let i = 0; i < 25; i++)
    assert.equal((await http.post(`${base}/files`, { name: `part-${i}.txt`, content: nearly })).status, 201);
  const full = await http.post(`${base}/files`, { name: "one-more.txt", content: nearly });
  assert.equal(full.status, 413);
  assert.equal(full.body.error.code, "storage_limit");
  const listed = await http.get(`${base}/files`);
  assert.equal(listed.body.usage.files, 25);
  assert.equal(listed.body.usage.bytes, 25 * FILE_LIMITS.fileBytes);
  // Fill the remaining slots with small files, then the count limit applies.
  for (let i = 25; i < FILE_LIMITS.files; i++)
    assert.equal((await http.post(`${base}/files`, { name: `note-${i}.md`, content: "ok" })).status, 201);
  const extra = await http.post(`${base}/files`, { name: "extra.md", content: "ok" });
  assert.equal(extra.status, 409);
  assert.equal(extra.body.error.code, "file_limit");
});
test("Office Files: files containing secrets are refused with an explanation", async (t) => {
  const r = await fixture("office_files");
  t.after(() => r.db.close());
  const owner = await r.login(),
    o = await r.office(owner.account),
    http = send(r, owner),
    base = `/api/offices/${o.id}`;
  for (const [content, kind] of [
    [
      "Backup words: abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      "seed phrase",
    ],
    ["deploy key sk-abcdefghijklmnopqrstuvwxyz0123", "API key"],
  ]) {
    const refused = await http.post(`${base}/files`, { name: "setup.txt", content });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, "secret_detected");
    assert.match(refused.body.error.message, new RegExp(kind));
    assert(!refused.body.error.message.includes("abandon"));
  }
  const created = await http.post(`${base}/files`, { name: "setup.txt", content: "No secrets here." });
  const question = await http.post(
    `${base}/file-questions/quote`,
    ask([created.body.id], "Is sk-abcdefghijklmnopqrstuvwxyz0123 valid?"),
  );
  assert.equal(question.body.error.code, "secret_detected");
  assert.equal((await r.db.office(o.id, (q) => q.query("SELECT * FROM office_files"))).length, 1);
});
test("Office Files: names, contents, questions and answers are encrypted at rest", async (t) => {
  const r = await fixture("office_files");
  t.after(() => r.db.close());
  const owner = await r.login(),
    o = await r.office(owner.account),
    http = send(r, owner),
    base = `/api/offices/${o.id}`;
  const created = await http.post(`${base}/files`, {
    name: "quarterly-plan.md",
    content: "Launch the sample garden project in spring.",
  });
  const quoted = await http.post(`${base}/file-questions/quote`, ask([created.body.id], "What launches in spring?"));
  await http.post(`${base}/file-questions`, {
    ...ask([created.body.id], "What launches in spring?"),
    id: uid("req_"),
    quoteId: quoted.body.quote.id,
  });
  const [row] = await r.db.office(o.id, (q) => q.query("SELECT * FROM office_files"));
  const raw = JSON.stringify(row);
  assert(!raw.includes("quarterly-plan"));
  assert(!raw.includes("garden"));
  assert.match(row.name_enc, /^v1\./);
  assert.match(row.content_enc, /^v1\./);
  const [history] = await r.db.office(o.id, (q) => q.query("SELECT * FROM office_file_questions"));
  const stored = JSON.stringify(history);
  assert(!stored.includes("spring"));
  assert(!stored.includes("Working answer"));
  assert(!stored.includes("quarterly-plan"));
  // Ciphertext is bound to its Office and record.
  assert.throws(() => r.crypto.open(o.id, `office_file:other:content`, row.content_enc));
  // Row-level security hides another Office's files.
  const other = await r.office(owner.account, "100", 2);
  assert.equal((await r.db.office(other.id, (q) => q.query("SELECT * FROM office_files"))).length, 0);
  assert.equal((await http.get(`/api/offices/${other.id}/files`)).body.files.length, 0);
});
test("Office Files: asking sends the selected files through quote, run and a signed receipt", async (t) => {
  const r = await fixture("office_files");
  t.after(() => r.db.close());
  const owner = await r.login(),
    o = await r.office(owner.account),
    http = send(r, owner),
    base = `/api/offices/${o.id}`;
  const sent: any[] = [];
  const complete = r.provider.complete;
  r.provider.complete = async (input, ...rest) => {
    sent.push(input);
    const result = await complete(input, ...rest);
    return { ...result, content: "The team meets on Tuesdays [handbook.md]." };
  };
  const handbookFile = (await http.post(`${base}/files`, { name: "handbook.md", content: handbook })).body,
    budgetFile = (await http.post(`${base}/files`, { name: "budget.csv", content: "item,amount\nsnacks,12\n" })).body,
    longFile = (
      await http.post(`${base}/files`, {
        name: "long-notes.txt",
        content: "z".repeat(FILE_LIMITS.chunkCharacters + 10),
      })
    ).body;
  const selection = ask([handbookFile.id, longFile.id]);
  const quoted = await http.post(`${base}/file-questions/quote`, selection);
  assert.equal(quoted.status, 200);
  assert.deepEqual(
    quoted.body.files.map((f: any) => f.name),
    ["handbook.md", "long-notes.txt"],
  );
  assert(Number(quoted.body.quote.maximumUsd) > 0);
  assert.equal(r.calls(), 0);
  // The quote binds the exact assembled request: a different selection cannot reuse it.
  const mismatch = await http.post(`${base}/file-questions`, {
    ...ask([budgetFile.id]),
    id: uid("req_"),
    quoteId: quoted.body.quote.id,
  });
  assert.equal(mismatch.body.error.code, "quote_invalid");
  const requestId = uid("req_");
  const answered = await http.post(`${base}/file-questions`, {
    ...selection,
    id: requestId,
    quoteId: quoted.body.quote.id,
  });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.status, "complete");
  assert.equal(answered.body.content, "The team meets on Tuesdays [handbook.md].");
  assert.equal(answered.body.receipt.payload.type, "usage");
  assert.equal(answered.body.receipt.payload.requestId, requestId);
  assert(await r.crypto.verify(answered.body.receipt));
  assert.equal(answered.body.chargedUsd, answered.body.receipt.payload.chargedUsd);
  // The provider received the instruction to cite, each file by name, the long file in parts, and the question.
  assert.equal(sent.length, 1);
  const messages = sent[0].messages as { role: string; content: string }[];
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /square brackets/);
  assert(messages.some((m) => m.content.startsWith("File [handbook.md]") && m.content.includes("every Tuesday")));
  assert(messages.some((m) => m.content.startsWith("File [long-notes.txt] (part 2 of 2)")));
  assert(messages.every((m) => m.content.length <= 60000));
  assert(!messages.some((m) => m.content.includes("snacks")));
  assert.equal(messages.at(-1)!.content, "Question: When does the team meet?");
  // The receipt is in the Ledger like any chat request.
  const ledger = await http.get(`${base}/ledger`);
  assert(ledger.body.some((x: any) => x.id === answered.body.receipt.payload.id));
  // History keeps the question, answer and cited files; a retried request is not stored twice.
  const retried = await http.post(`${base}/file-questions`, {
    ...selection,
    id: requestId,
    quoteId: quoted.body.quote.id,
  });
  assert.equal(retried.body.historyId, answered.body.historyId);
  assert.equal(r.calls(), 1);
  const history = (await http.get(`${base}/file-questions`)).body;
  assert.equal(history.length, 1);
  assert.equal(history[0].question, "When does the team meet?");
  assert.equal(history[0].answer, "The team meets on Tuesdays [handbook.md].");
  assert.deepEqual(
    history[0].files.map((f: any) => f.name),
    ["handbook.md", "long-notes.txt"],
  );
  assert.equal(history[0].receiptId, answered.body.receipt.payload.id);
  assert.equal(history[0].askedByYou, true);
  assert.equal((await http.delete(`${base}/file-questions/${history[0].id}`)).body.deleted, true);
  assert.equal((await http.get(`${base}/file-questions`)).body.length, 0);
});
test("Office Files: oversized selections name the files to deselect", async (t) => {
  const r = await fixture("office_files");
  t.after(() => r.db.close());
  const owner = await r.login(),
    o = await r.office(owner.account),
    http = send(r, owner),
    base = `/api/offices/${o.id}`;
  const ids: string[] = [];
  for (const name of ["a.txt", "b.txt"])
    ids.push(
      (await http.post(`${base}/files`, { name, content: "q".repeat(FILE_LIMITS.fileBytes) })).body.id,
    );
  ids.push((await http.post(`${base}/files`, { name: "small.md", content: handbook })).body.id);
  const tooLarge = await http.post(`${base}/file-questions/quote`, ask(ids));
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.error.code, "selection_too_large");
  assert.match(tooLarge.body.error.message, /Deselect “a\.txt”/);
  assert(!tooLarge.body.error.message.includes("small.md"));
  // A model's published context window is respected too.
  r.provider.models = async () => [{ id: "small-model", name: "Small model", context_length: 30000 }];
  const context = await http.post(`${base}/file-questions/quote`, {
    ...ask([ids[0], ids[2]]),
    model: "small-model",
  });
  assert.equal(context.body.error.code, "selection_too_large");
  assert.match(context.body.error.message, /Deselect “a\.txt”/);
  assert.equal(r.calls(), 0);
});
