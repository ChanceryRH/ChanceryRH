import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, MEMBER, chat } from "./fixture.ts";
import { PRODUCTIVITY_UPDATES } from "../shared/productivity.ts";
import { uid, MerkleTree } from "../server/crypto.ts";
import { seatLeaf } from "../server/chain.ts";
import { dollars } from "../shared/money.ts";
const flags = PRODUCTIVITY_UPDATES.map((x) => x.id).join(",");
type Runtime = Awaited<ReturnType<typeof fixture>>;
type Session = Awaited<ReturnType<Runtime["login"]>>;
function http(r: Runtime, u: Session, office: string) {
  const base = `/api/offices/${office}/productivity`;
  return {
    get: (path: string) => u.agent.get(base + path),
    post: (path: string, body: any) =>
      u.agent
        .post(base + path)
        .set("Origin", r.cfg.origin)
        .set("X-CSRF-Token", u.csrf)
        .send(body),
    delete: (path: string) =>
      u.agent
        .delete(base + path)
        .set("Origin", r.cfg.origin)
        .set("X-CSRF-Token", u.csrf),
  };
}
async function setup(t: any, released = flags) {
  const r = await fixture(released);
  t.after(() => r.db.close());
  const u = await r.login(),
    o = await r.office(u.account);
  r.provider.catalog = async () => [
    {
      id: "test-model",
      name: "Test model",
      contextLength: 100000,
      maxTokens: 8192,
      inputUsdPerMillion: "1",
      outputUsdPerMillion: "2",
      lanes: ["standard"],
    },
  ];
  return { r, u, o, h: http(r, u, o.id) };
}
async function conversation(r: Runtime, o: any, ephemeral = false) {
  const c = await r.conversations.create(o.access, {
    title: "Launch planning",
    ephemeral,
  });
  const input = { ...chat, conversationId: c.id };
  const q = await r.ledger.quote(o.access, input);
  await r.ledger.request(o.access, {
    id: uid("request_"),
    quoteId: q.id,
    chat: input,
  });
  const messages = await r.conversations.messages(o.access, c.id);
  return { c, messages };
}
async function addSeat(r: Runtime, u: Session, o: any, role = "member") {
  const id = uid("seat_"),
    cap = dollars("10").toString(),
    leaf = seatLeaf(u.account.credential, role as any, cap, null);
  await r.db.office(o.id, async (q) => {
    await q.query(
      "INSERT INTO seats(id,office_id,account_id,credential,role,monthly_cap_pico,status,leaf) VALUES($1,$2,$3,$4,$5,$6,'active',$7)",
      [id, o.id, u.account.id, u.account.credential, role, cap, leaf],
    );
    const seats = await q.query(
      "SELECT credential,leaf FROM seats WHERE status='active'",
    );
    const root = new MerkleTree(
      seats
        .sort((a, b) => a.credential.localeCompare(b.credential))
        .map((s) => s.leaf),
    ).root;
    await q.query("UPDATE seats SET approved_root=$1", [root]);
    r.snapshots.get(o.id)!.seatRoot = root;
  });
}
test("all ten productivity releases are hidden and their routes gated independently", async (t) => {
  const { r, u, o, h } = await setup(t, "");
  const cfg = await u.agent.get("/api/config");
  assert(
    PRODUCTIVITY_UPDATES.every(
      (x) => !cfg.body.updates.some((v: any) => v.id === x.id),
    ),
  );
  for (const id of PRODUCTIVITY_UPDATES.map((x) => x.id)) {
    const method = ["chat_branches"].includes(id) ? "post" : "get";
    const path =
      id === "conversation_exports" ? `/${id}/conversation_x` : `/${id}`;
    const response =
      method === "post" ? await h.post(path, {}) : await h.get(path);
    assert.equal(response.status, 404, id);
    assert.equal(response.body.error.code, "update_unavailable", id);
  }
  r.cfg.released.add("draft_recovery");
  assert.equal((await h.get("/draft_recovery")).status, 200);
  assert.equal((await h.get("/action_lists")).status, 404);
});
test("Chat Library renames encrypted titles, pins, archives, restores, and keeps members separate", async (t) => {
  const { r, u, o, h } = await setup(t);
  const { c } = await conversation(r, o);
  assert.equal(
    (
      await h.post(`/chat_library/${c.id}`, {
        title: "Product launch plan",
        pinned: true,
        archived: true,
      })
    ).status,
    200,
  );
  const library = await h.get("/chat_library");
  assert.equal(library.body.conversations[0].title, "Product launch plan");
  assert.equal(library.body.conversations[0].pinned, true);
  assert.equal(library.body.conversations[0].archived, true);
  const active = await u.agent.get(`/api/offices/${o.id}/conversations`);
  assert.equal(active.body.length, 0);
  const v = await r.login(MEMBER);
  await addSeat(r, v, o);
  assert.equal(
    (
      await http(r, v, o.id).post(`/chat_library/${c.id}`, {
        title: "Stolen",
        pinned: false,
        archived: false,
      })
    ).status,
    404,
  );
  const raw = await r.db.office(o.id, (q) =>
    q.query("SELECT title_enc FROM conversations WHERE id=$1", [c.id]),
  );
  assert(!JSON.stringify(raw).includes("Product launch plan"));
  await h.post(`/chat_library/${c.id}`, {
    title: "Product launch plan",
    pinned: true,
    archived: false,
  });
  assert.equal(
    (await u.agent.get(`/api/offices/${o.id}/conversations`)).body.length,
    1,
  );
});
test("Conversation Branches re-encrypt exact prefix without inference or copied charges", async (t) => {
  const { r, o, h } = await setup(t);
  const { c, messages } = await conversation(r, o),
    calls = r.calls();
  const branch = await h.post("/chat_branches", {
    conversationId: c.id,
    throughMessageId: messages[0].id,
    title: "Try another angle",
  });
  assert.equal(branch.status, 200);
  assert.equal(branch.body.messagesCopied, 1);
  assert.equal(r.calls(), calls);
  const stored = await r.conversations.messages(o.access, branch.body.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].content, messages[0].content);
  assert.notEqual(stored[0].id, messages[0].id);
  assert.equal((await r.conversations.messages(o.access, c.id)).length, 2);
  assert.equal(
    (
      await h.post("/chat_branches", {
        conversationId: c.id,
        throughMessageId: "message_missing",
        title: "No",
      })
    ).status,
    404,
  );
  const [counts] = await r.db.office(o.id, (q) =>
    q.query(
      "SELECT count(*)::int AS count FROM requests WHERE conversation_id=$1",
      [branch.body.id],
    ),
  );
  assert.equal(counts.count, 0);
});
test("Answer Vault copies only owned assistant answers and survives source deletion", async (t) => {
  const { r, o, h } = await setup(t),
    { c, messages } = await conversation(r, o);
  const invalid = await h.post("/answer_vault", {
    conversationId: c.id,
    messageId: messages[0].id,
    label: "No user messages",
  });
  assert.equal(invalid.status, 404);
  const saved = await h.post("/answer_vault", {
    conversationId: c.id,
    messageId: messages[1].id,
    label: "Useful launch plan",
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.value.content, "Working answer");
  await r.conversations.remove(o.access, c.id);
  const list = await h.get("/answer_vault");
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].value.content, "Working answer");
  assert.equal(
    (await h.delete(`/answer_vault/${saved.body.id}?version=1`)).status,
    200,
  );
  assert.equal((await h.get("/answer_vault")).body.length, 0);
});
test("Exports return real text/JSON, never export temporary or another member conversation", async (t) => {
  const { r, o, h } = await setup(t),
    { c } = await conversation(r, o);
  const json = await h.get(`/conversation_exports/${c.id}?format=json`);
  assert.equal(json.status, 200);
  assert.equal(json.body.messages.length, 2);
  assert.equal(json.body.title, "Launch planning");
  assert.equal(json.headers["cache-control"], "no-store");
  const md = await h.get(`/conversation_exports/${c.id}?format=markdown`);
  assert.equal(md.status, 200);
  assert(md.text.includes("# Launch planning"));
  assert(md.text.includes("Working answer"));
  const temp = await r.conversations.create(o.access, {
    title: "Temporary",
    ephemeral: true,
  });
  assert.equal((await h.get(`/conversation_exports/${temp.id}`)).status, 409);
  const other = await r.login(MEMBER);
  await addSeat(r, other, o);
  assert.equal(
    (await http(r, other, o.id).get(`/conversation_exports/${c.id}`)).status,
    404,
  );
});
test("Personal Instructions are encrypted, versioned, guarded, and never automatically call AI", async (t) => {
  const { r, o, h } = await setup(t);
  assert.equal(
    (
      await h.post("/personal_instructions", {
        text: "Write clearly for product teams.",
        version: 0,
      })
    ).status,
    200,
  );
  assert.equal(r.calls(), 0);
  const list = await h.get("/personal_instructions");
  assert.equal(list.body[0].value.text, "Write clearly for product teams.");
  assert.equal(
    (await h.post("/personal_instructions", { text: "stale tab", version: 0 }))
      .status,
    409,
  );
  const rows = await r.db.office(o.id, (q) =>
    q.query("SELECT value_enc FROM productivity_items"),
  );
  assert(!JSON.stringify(rows).includes("Write clearly"));
  assert.equal(
    (
      await h.post("/personal_instructions", {
        text: "x".repeat(6001),
        version: 1,
      })
    ).status,
    400,
  );
  assert.equal(
    (await h.post("/personal_instructions", { text: "", version: 1 })).body
      .value.text,
    "",
  );
});
test("Draft Recovery saves explicitly, prevents lost edits, deletes with a version, and isolates accounts", async (t) => {
  const { r, o, h } = await setup(t);
  const saved = await h.post("/draft_recovery", {
    title: "Launch email",
    text: "Please help write an announcement.",
    version: 0,
  });
  assert.equal(saved.status, 200);
  const id = saved.body.id;
  assert.equal(
    (
      await h.post("/draft_recovery", {
        id,
        title: "Launch email",
        text: "New text",
        version: 1,
      })
    ).body.version,
    2,
  );
  assert.equal(
    (
      await h.post("/draft_recovery", {
        id,
        title: "Launch email",
        text: "Old text",
        version: 1,
      })
    ).status,
    409,
  );
  assert.equal((await h.delete(`/draft_recovery/${id}?version=1`)).status, 409);
  const other = await r.login(MEMBER);
  await addSeat(r, other, o);
  assert.deepEqual(
    (await http(r, other, o.id).get("/draft_recovery")).body,
    [],
  );
  assert.equal(
    (await http(r, other, o.id).delete(`/draft_recovery/${id}?version=2`))
      .status,
    409,
  );
  assert.equal((await h.delete(`/draft_recovery/${id}?version=2`)).status, 200);
  assert.equal(r.calls(), 0);
});
test("Favorites validate current model and Office policy without inference", async (t) => {
  const { r, o, h } = await setup(t);
  assert.equal(
    (await h.post("/model_favorites", { models: ["test-model"], version: 0 }))
      .status,
    200,
  );
  assert.equal(
    (await h.post("/model_favorites", { models: ["unavailable"], version: 1 }))
      .status,
    400,
  );
  await r.db.query(
    "UPDATE offices SET policy=jsonb_set(policy,'{allowedModels}',$1::jsonb) WHERE id=$2",
    [JSON.stringify(["other-model"]), o.id],
  );
  assert.equal(
    (await h.post("/model_favorites", { models: ["test-model"], version: 1 }))
      .status,
    400,
  );
  assert.equal(r.calls(), 0);
});
test("Spend Radar totals actual receipts and preserves per-member Ledger visibility", async (t) => {
  const { r, o, h } = await setup(t);
  await conversation(r, o);
  const radar = await h.get("/spend_radar");
  assert.equal(radar.status, 200);
  assert.equal(radar.body.scope, "Office receipts");
  assert.equal(radar.body.receiptCount, 1);
  assert.equal(radar.body.totalUsd, "0.0105");
  assert.equal(radar.body.platformFeeUsd, "0.0005");
  assert.equal(radar.body.models[0].requests, 1);
  const other = await r.login(MEMBER);
  await addSeat(r, other, o);
  const own = await http(r, other, o.id).get("/spend_radar");
  assert.equal(own.body.scope, "Your receipts");
  assert.equal(own.body.receiptCount, 0);
  assert.equal((await h.get("/spend_radar?month=2026-99")).status, 400);
});
test("Request History reads statuses, paginates, and never replays inference", async (t) => {
  const { r, o, h } = await setup(t);
  await conversation(r, o);
  const before = r.calls();
  const history = await h.get("/request_history");
  assert.equal(history.status, 200);
  assert.equal(history.body.requests[0].status, "complete");
  assert.equal(history.body.requests[0].chargedUsd, "0.0105");
  assert.equal(history.body.hasMore, false);
  assert(!JSON.stringify(history.body).includes("Working answer"));
  assert.equal(
    (await h.get("/request_history?page=1")).body.requests.length,
    0,
  );
  assert.equal((await h.get("/request_history?page=-1")).status, 400);
  assert.equal(r.calls(), before);
  const other = await r.login(MEMBER);
  await addSeat(r, other, o);
  assert.equal(
    (await http(r, other, o.id).get("/request_history")).body.requests.length,
    0,
  );
});
test("Action Lists handle dates, linked chats, completion, conflicts and account isolation", async (t) => {
  const { r, o, h } = await setup(t),
    { c } = await conversation(r, o);
  const body = {
    title: "Send the final plan",
    notes: "Review before sending.",
    due: "2027-01-12",
    conversationId: c.id,
    version: 0,
  };
  const saved = await h.post("/action_lists", body);
  assert.equal(saved.status, 200);
  const updated = await h.post("/action_lists", {
    ...body,
    id: saved.body.id,
    version: 1,
    done: true,
  });
  assert.equal(updated.body.value.done, true);
  assert.equal(
    (
      await h.post("/action_lists", {
        ...body,
        id: saved.body.id,
        version: 1,
        done: false,
      })
    ).status,
    409,
  );
  assert.equal(
    (await h.post("/action_lists", { ...body, due: "2027-02-30" })).status,
    400,
  );
  assert.equal(
    (
      await h.post("/action_lists", {
        ...body,
        conversationId: "conversation_missing",
      })
    ).status,
    404,
  );
  const other = await r.login(MEMBER);
  await addSeat(r, other, o);
  assert.equal(
    (await http(r, other, o.id).get("/action_lists")).body.length,
    0,
  );
  assert.equal(
    (await http(r, other, o.id).post("/action_lists", body)).status,
    404,
  );
});
test("Personal collections enforce guards, guest restrictions, CSRF, tenant isolation and capacity", async (t) => {
  const { r, u, o, h } = await setup(t);
  const secret = "sk-proj-" + "a".repeat(64);
  assert.equal(
    (
      await h.post("/draft_recovery", {
        title: "credential",
        text: secret,
        version: 0,
      })
    ).status,
    400,
  );
  const rejected = await u.agent
    .post(`/api/offices/${o.id}/productivity/action_lists`)
    .set("Origin", r.cfg.origin)
    .send({ title: "No CSRF" });
  assert.equal(rejected.status, 403);
  const other = await r.login(MEMBER);
  const otherOffice = await r.office(u.account, "100", 2);
  assert.notEqual(otherOffice.id, o.id);
  assert.equal((await http(r, other, o.id).get("/draft_recovery")).status, 403);
  await addSeat(r, other, o, "guest");
  assert.equal((await http(r, other, o.id).get("/action_lists")).status, 403);
  await r.db.office(o.id, async (q) => {
    for (let i = 0; i < 200; i++)
      await q.query(
        "INSERT INTO productivity_items(id,office_id,account_id,kind,value_enc) VALUES($1,$2,$3,'draft_recovery',$4)",
        [
          "draft_" + i,
          o.id,
          u.account.id,
          r.crypto.seal(
            o.id,
            `personal:${u.account.id}:draft_recovery:draft_${i}`,
            { title: "saved", text: "saved" },
          ),
        ],
      );
  });
  assert.equal(
    (
      await h.post("/draft_recovery", {
        title: "Overflow",
        text: "No",
        version: 0,
      })
    ).status,
    409,
  );
});

test("Action Lists remain usable after their original conversation is deleted", async (t) => {
  const { r, o, h } = await setup(t),
    { c } = await conversation(r, o);
  const saved = await h.post("/action_lists", {
    title: "Finish the plan",
    conversationId: c.id,
    version: 0,
  });
  await r.conversations.remove(o.access, c.id);
  const completed = await h.post("/action_lists", {
    id: saved.body.id,
    ...saved.body.value,
    done: true,
    version: 1,
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.value.done, true);
  assert.equal(completed.body.value.conversationId, null);
});
