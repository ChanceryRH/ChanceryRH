import { z } from "zod";
import { uid } from "../crypto.ts";
import { assert } from "../errors.ts";
import { checkGuards } from "../../shared/guards.ts";
import { picoToUsdString, dollars, usdgToPico } from "../../shared/money.ts";
import type { Access } from "../offices.ts";
import type { Query } from "../db.ts";
import type { FeatureContext } from "./index.ts";
import type {
  ProductivityId,
  PersonalItem,
} from "../../shared/productivity.ts";
const idSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + "T00:00:00Z");
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Choose a valid date.");
const versionSchema = z.number().int().min(0).max(2147483646);
function member(a: Access) {
  assert(
    a.role !== "guest",
    403,
    "role_required",
    "These tools are for active Office members.",
  );
}
function clean(...text: string[]) {
  const g = checkGuards(...text);
  assert(!g, 400, "secret_detected", g?.message || "Remove secret material.");
}
export function register(ctx: FeatureContext) {
  const { db, crypto, route, param, conversations, provider, ledger } = ctx;
  const sealContext = (a: Access, kind: string, id: string) =>
    `personal:${a.account.id}:${kind}:${id}`;
  const unpack = (a: Access, r: any): PersonalItem => ({
    id: r.id,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    value: crypto.open(a.office.id, sealContext(a, r.kind, r.id), r.value_enc),
  });
  async function items(a: Access, kind: ProductivityId) {
    member(a);
    return db.office(a.office.id, async (q) =>
      (
        await q.query(
          "SELECT * FROM productivity_items WHERE account_id=$1 AND kind=$2 ORDER BY updated_at DESC,id LIMIT 201",
          [a.account.id, kind],
        )
      ).map((r) => unpack(a, r)),
    );
  }
  async function own(q: Query, a: Access, id: string) {
    const [c] = await q.query(
      "SELECT * FROM conversations WHERE id=$1 AND account_id=$2",
      [id, a.account.id],
    );
    assert(c, 404, "conversation_not_found", "Conversation not found.");
    return c;
  }
  async function put(
    a: Access,
    kind: ProductivityId,
    id: string,
    value: unknown,
    version: number,
  ) {
    member(a);
    idSchema.parse(id);
    return db.office(a.office.id, async (q) => {
      await q.query("SELECT * FROM office_locks FOR UPDATE");
      const [prior] = await q.query(
        "SELECT * FROM productivity_items WHERE account_id=$1 AND kind=$2 AND id=$3",
        [a.account.id, kind, id],
      );
      assert(
        (prior?.version || 0) === version,
        409,
        "edit_conflict",
        "This item changed in another tab. Refresh before saving.",
      );
      if (!prior) {
        const [count] = await q.query(
          "SELECT count(*)::int AS count FROM productivity_items WHERE account_id=$1 AND kind=$2",
          [a.account.id, kind],
        );
        assert(
          count.count < 200,
          409,
          "collection_full",
          "This collection holds 200 items. Remove an older item first.",
        );
      }
      const enc = crypto.seal(a.office.id, sealContext(a, kind, id), value);
      const [r] = await q.query(
        "INSERT INTO productivity_items(id,office_id,account_id,kind,value_enc) VALUES($1,$2,$3,$4,$5) ON CONFLICT(office_id,account_id,kind,id) DO UPDATE SET value_enc=excluded.value_enc,version=productivity_items.version+1,updated_at=now() RETURNING *",
        [id, a.office.id, a.account.id, kind, enc],
      );
      return unpack(a, r);
    });
  }
  const root = "/productivity";
  const listRoute = (kind: ProductivityId) =>
    route("get", `${root}/${kind}`, (a) => items(a, kind), kind);
  const deleteRoute = (kind: ProductivityId) =>
    route(
      "delete",
      `${root}/${kind}/:id`,
      async (a, r) => {
        member(a);
        const version = z.coerce.number().int().min(1).parse(r.query.version);
        return db.office(a.office.id, async (q) => {
          const removed = await q.query(
            "DELETE FROM productivity_items WHERE account_id=$1 AND kind=$2 AND id=$3 AND version=$4 RETURNING id",
            [a.account.id, kind, param(r, "id"), version],
          );
          assert(
            removed.length,
            409,
            "edit_conflict",
            "Item missing or changed. Refresh before deleting.",
          );
          return { deleted: true };
        });
      },
      kind,
    );
  route(
    "get",
    `${root}/chat_library`,
    async (a) => {
      member(a);
      const [chats, meta] = await Promise.all([
        conversations.list(a),
        items(a, "chat_library"),
      ]);
      const mapped = new Map(meta.map((x) => [x.id, x.value]));
      return {
        limit: 200,
        conversations: chats
          .map((c) => ({
            ...c,
            pinned: !!mapped.get(c.id)?.pinned,
            archived: !!mapped.get(c.id)?.archived,
          }))
          .sort((a, b) => Number(b.pinned) - Number(a.pinned)),
      };
    },
    "chat_library",
  );
  route(
    "post",
    `${root}/chat_library/:id`,
    async (a, r) => {
      member(a);
      const input = z
        .strictObject({
          title: z.string().trim().min(1).max(200),
          pinned: z.boolean(),
          archived: z.boolean(),
        })
        .parse(r.body);
      clean(input.title);
      const id = param(r, "id");
      return db.office(a.office.id, async (q) => {
        await q.query("SELECT * FROM office_locks FOR UPDATE");
        await own(q, a, id);
        await q.query(
          "UPDATE conversations SET title_enc=$1 WHERE id=$2 AND account_id=$3",
          [
            crypto.seal(a.office.id, `conversation:${id}`, input.title),
            id,
            a.account.id,
          ],
        );
        const enc = crypto.seal(
          a.office.id,
          sealContext(a, "chat_library", id),
          { pinned: input.pinned, archived: input.archived },
        );
        await q.query(
          "INSERT INTO productivity_items(id,office_id,account_id,kind,value_enc) VALUES($1,$2,$3,'chat_library',$4) ON CONFLICT(office_id,account_id,kind,id) DO UPDATE SET value_enc=excluded.value_enc,version=productivity_items.version+1,updated_at=now()",
          [id, a.office.id, a.account.id, enc],
        );
        return { id, ...input };
      });
    },
    "chat_library",
  );
  route(
    "post",
    `${root}/chat_branches`,
    async (a, r) => {
      member(a);
      const input = z
        .strictObject({
          conversationId: idSchema,
          throughMessageId: idSchema,
          title: z.string().trim().min(1).max(200),
        })
        .parse(r.body);
      clean(input.title);
      return db.office(a.office.id, async (q) => {
        await q.query("SELECT * FROM office_locks FOR UPDATE");
        const c = await own(q, a, input.conversationId);
        assert(
          !c.ephemeral,
          409,
          "temporary_conversation",
          "Temporary conversations cannot be branched.",
        );
        const messages = await q.query(
          "SELECT * FROM messages WHERE conversation_id=$1 AND account_id=$2 ORDER BY ordinal LIMIT 1001",
          [c.id, a.account.id],
        );
        const at = messages.findIndex((m) => m.id === input.throughMessageId);
        assert(
          at >= 0,
          404,
          "message_not_found",
          "Choose a stored message from this conversation.",
        );
        assert(
          at < 98,
          400,
          "branch_context_limit",
          "Choose a branch point within the first 98 messages so there is room for your next prompt.",
        );
        const id = uid("conversation_");
        await q.query(
          "INSERT INTO conversations(id,office_id,account_id,title_enc,ephemeral) VALUES($1,$2,$3,$4,false)",
          [
            id,
            a.office.id,
            a.account.id,
            crypto.seal(a.office.id, `conversation:${id}`, input.title),
          ],
        );
        for (const m of messages.slice(0, at + 1)) {
          const mid = uid("message_");
          await q.query(
            "INSERT INTO messages(id,office_id,conversation_id,account_id,role,content_enc,model) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              mid,
              a.office.id,
              id,
              a.account.id,
              m.role,
              crypto.seal(
                a.office.id,
                `message:${mid}`,
                crypto.open(a.office.id, `message:${m.id}`, m.content_enc),
              ),
              m.model,
            ],
          );
        }
        return {
          id,
          title: input.title,
          sourceConversationId: c.id,
          messagesCopied: at + 1,
          inferenceStarted: false,
        };
      });
    },
    "chat_branches",
  );
  listRoute("answer_vault");
  deleteRoute("answer_vault");
  route(
    "post",
    `${root}/answer_vault`,
    async (a, r) => {
      member(a);
      const input = z
        .strictObject({
          conversationId: idSchema,
          messageId: idSchema,
          label: z.string().trim().min(1).max(160),
        })
        .parse(r.body);
      clean(input.label);
      const value = await db.office(a.office.id, async (q) => {
        const c = await own(q, a, input.conversationId);
        assert(
          !c.ephemeral,
          409,
          "temporary_conversation",
          "Temporary answers are not retained.",
        );
        const [m] = await q.query(
          "SELECT * FROM messages WHERE id=$1 AND conversation_id=$2 AND account_id=$3 AND role='assistant'",
          [input.messageId, c.id, a.account.id],
        );
        assert(m, 404, "message_not_found", "Stored answer not found.");
        const content = crypto.open(
          a.office.id,
          `message:${m.id}`,
          m.content_enc,
        );
        clean(content);
        return {
          label: input.label,
          content,
          model: m.model,
          conversationId: c.id,
          messageId: m.id,
        };
      });
      return put(a, "answer_vault", uid("answer_"), value, 0);
    },
    "answer_vault",
  );
  route(
    "get",
    `${root}/conversation_exports/:id`,
    async (a, r, res) => {
      member(a);
      const format = z
          .enum(["json", "markdown"])
          .parse(r.query.format || "json"),
        id = param(r, "id");
      const c = await db.office(a.office.id, (q) => own(q, a, id));
      assert(
        !c.ephemeral,
        409,
        "temporary_conversation",
        "Temporary conversations have no retained transcript to export.",
      );
      const [count] = await db.office(a.office.id, (q) =>
        q.query(
          "SELECT count(*)::int AS count FROM messages WHERE conversation_id=$1 AND account_id=$2",
          [id, a.account.id],
        ),
      );
      assert(
        count.count <= 1000,
        413,
        "export_limit",
        "This conversation exceeds the 1,000-message export limit. No partial export was created.",
      );
      const messages = await conversations.messages(a, id);
      const title = crypto.open(a.office.id, `conversation:${id}`, c.title_enc);
      const value = {
        format: "chancery-conversation-v1",
        title,
        conversationId: id,
        exportedAt: new Date().toISOString(),
        messages,
      };
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="chancery-conversation.${format === "json" ? "json" : "md"}"`,
      );
      if (format === "json") return res.json(value);
      res
        .type("text/markdown")
        .send(
          `# ${title}\n\nExported from Chancery. AI output may contain errors.\n\n${messages.map((m) => `## ${m.role === "assistant" ? "Assistant" : "You"}${m.model ? ` · ${m.model}` : ""}\n\n${m.content}`).join("\n\n---\n\n")}`,
        );
    },
    "conversation_exports",
  );
  listRoute("personal_instructions");
  route(
    "post",
    `${root}/personal_instructions`,
    async (a, r) => {
      const v = z
        .strictObject({ text: z.string().max(6000), version: versionSchema })
        .parse(r.body);
      clean(v.text);
      return put(
        a,
        "personal_instructions",
        "instructions",
        { text: v.text },
        v.version,
      );
    },
    "personal_instructions",
  );
  listRoute("draft_recovery");
  deleteRoute("draft_recovery");
  route(
    "post",
    `${root}/draft_recovery`,
    async (a, r) => {
      member(a);
      const v = z
        .strictObject({
          id: idSchema.optional(),
          title: z.string().trim().min(1).max(160),
          text: z.string().trim().min(1).max(60000),
          version: versionSchema.default(0),
        })
        .parse(r.body);
      clean(v.title, v.text);
      return put(
        a,
        "draft_recovery",
        v.id || uid("draft_"),
        { title: v.title, text: v.text },
        v.version,
      );
    },
    "draft_recovery",
  );
  listRoute("model_favorites");
  route(
    "post",
    `${root}/model_favorites`,
    async (a, r) => {
      member(a);
      const v = z
        .strictObject({
          models: z.array(z.string().max(160)).max(30),
          version: versionSchema,
        })
        .parse(r.body);
      const available = await provider.catalog();
      const allowed = new Set(
        available
          .filter(
            (m) =>
              (!a.office.policy.allowedModels.length ||
                a.office.policy.allowedModels.includes(m.id)) &&
              m.lanes.some((l) => a.office.policy.allowedLanes.includes(l)),
          )
          .map((m) => m.id),
      );
      assert(
        v.models.every((id) => allowed.has(id)),
        400,
        "model_unavailable",
        "Choose models currently available under your Office policy.",
      );
      return put(
        a,
        "model_favorites",
        "favorites",
        { models: [...new Set(v.models)] },
        v.version,
      );
    },
    "model_favorites",
  );
  route(
    "get",
    `${root}/spend_radar`,
    async (a, r) => {
      member(a);
      const month = z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
        .parse(r.query.month || new Date().toISOString().slice(0, 7));
      const rows = await ledger.list(a, month);
      let total = 0n,
        seat = 0n,
        fees = 0n,
        unsettled = 0n;
      let provisional = 0;
      const models = new Map<string, { requests: number; amount: bigint }>();
      for (const row of rows) {
        const p = row.envelope.payload,
          amount = dollars(String(p.chargedUsd || "0"), "1000000");
        total += amount;
        if (p.type === "seat_fee") seat += amount;
        else {
          const m = models.get(p.model) || { requests: 0, amount: 0n };
          m.requests++;
          m.amount += amount;
          models.set(p.model, m);
          fees += dollars(String(p.platformFeeUsd || "0"), "1000000");
        }
        if (!row.settlement_id) unsettled += amount;
        if (p.status === "pending") provisional++;
      }
      return {
        month,
        scope: ["principal", "officer"].includes(a.role)
          ? "Office receipts"
          : "Your receipts",
        receiptCount: rows.length,
        limited: rows.length === 5000,
        totalUsd: picoToUsdString(total),
        seatUsd: picoToUsdString(seat),
        usageUsd: picoToUsdString(total - seat),
        platformFeeUsd: picoToUsdString(fees),
        unsettledUsd: picoToUsdString(unsettled),
        provisional,
        models: [...models]
          .map(([model, x]) => ({
            model,
            requests: x.requests,
            chargedUsd: picoToUsdString(x.amount),
          }))
          .sort((a, b) => Number(b.chargedUsd) - Number(a.chargedUsd)),
        officeCapUsd: picoToUsdString(BigInt(a.office.cap_pico)),
        officeSpentUsd: picoToUsdString(
          usdgToPico(a.snapshot?.spentUnits || 0n),
        ),
      };
    },
    "spend_radar",
  );
  route(
    "get",
    `${root}/request_history`,
    async (a, r) => {
      member(a);
      const page = z.coerce
        .number()
        .int()
        .min(0)
        .max(10000)
        .parse(r.query.page || 0);
      return db.office(a.office.id, async (q) => {
        const rows = await q.query(
          "SELECT id,status,model,lane,reserved_pico,charged_pico,receipt_id,conversation_id,created_at,completed_at FROM requests WHERE account_id=$1 ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET $2",
          [a.account.id, page * 50],
        );
        return {
          page,
          hasMore: rows.length > 50,
          requests: rows.slice(0, 50).map((x) => ({
            id: x.id,
            status: x.status,
            model: x.model,
            lane: x.lane,
            reservedUsd: picoToUsdString(BigInt(x.reserved_pico)),
            chargedUsd:
              x.charged_pico === null
                ? null
                : picoToUsdString(BigInt(x.charged_pico)),
            receiptId: x.receipt_id,
            conversationId: x.conversation_id,
            createdAt: x.created_at,
            completedAt: x.completed_at,
          })),
        };
      });
    },
    "request_history",
  );
  listRoute("action_lists");
  deleteRoute("action_lists");
  route(
    "post",
    `${root}/action_lists`,
    async (a, r) => {
      member(a);
      const v = z
        .strictObject({
          id: idSchema.optional(),
          title: z.string().trim().min(1).max(200),
          notes: z.string().max(4000).default(""),
          due: dateSchema.nullable().default(null),
          done: z.boolean().default(false),
          conversationId: idSchema.nullable().default(null),
          version: versionSchema.default(0),
        })
        .parse(r.body);
      clean(v.title, v.notes);
      if (v.conversationId) {
        await db.office(a.office.id, async (q) => {
          const [source] = await q.query(
            "SELECT id FROM conversations WHERE id=$1 AND account_id=$2",
            [v.conversationId, a.account.id],
          );
          if (source) return;
          const [prior] = v.id
            ? await q.query(
                "SELECT * FROM productivity_items WHERE account_id=$1 AND kind='action_lists' AND id=$2",
                [a.account.id, v.id],
              )
            : [];
          assert(
            prior && unpack(a, prior).value.conversationId === v.conversationId,
            404,
            "conversation_not_found",
            "Conversation not found.",
          );
          // A task survives deletion of its original chat; detach the stale link.
          v.conversationId = null;
        });
      }
      return put(
        a,
        "action_lists",
        v.id || uid("task_"),
        {
          title: v.title,
          notes: v.notes,
          due: v.due,
          done: v.done,
          conversationId: v.conversationId,
        },
        v.version,
      );
    },
    "action_lists",
  );
}
