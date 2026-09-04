import { z } from "zod";
import { uid, type CryptoService } from "./crypto.ts";
import { assert } from "./errors.ts";
import { checkGuards } from "../shared/guards.ts";
import type { Database } from "./db.ts";
import type { Access } from "./offices.ts";
export function createConversations(db: Database, crypto: CryptoService) {
  return {
    async create(a: Access, body: unknown) {
      assert(
        a.role !== "guest",
        403,
        "room_only",
        "Guests can access only their assigned Room.",
      );
      const input = z
          .strictObject({
            title: z.string().max(200).default("New conversation"),
            ephemeral: z.boolean().default(false),
          })
          .parse(body),
        guard = checkGuards(input.title);
      assert(
        !guard,
        400,
        "secret_detected",
        guard?.message || "Remove secret material.",
      );
      const id = uid("conversation_");
      await db.office(a.office.id, (q) =>
        q.query(
          "INSERT INTO conversations(id,office_id,account_id,title_enc,ephemeral) VALUES($1,$2,$3,$4,$5)",
          [
            id,
            a.office.id,
            a.account.id,
            crypto.seal(a.office.id, `conversation:${id}`, input.title),
            input.ephemeral,
          ],
        ),
      );
      return { id, ...input };
    },
    async list(a: Access) {
      return db.office(a.office.id, async (q) =>
        (
          await q.query(
            "SELECT * FROM conversations WHERE account_id=$1 ORDER BY created_at DESC LIMIT 200",
            [a.account.id],
          )
        ).map((c) => ({
          id: c.id,
          title: crypto.open(a.office.id, `conversation:${c.id}`, c.title_enc),
          ephemeral: c.ephemeral,
          createdAt: c.created_at,
        })),
      );
    },
    async messages(a: Access, id: string) {
      return db.office(a.office.id, async (q) => {
        const [c] = await q.query(
          "SELECT id FROM conversations WHERE id=$1 AND account_id=$2",
          [id, a.account.id],
        );
        assert(c, 404, "conversation_not_found", "Conversation not found.");
        return (
          await q.query(
            "SELECT * FROM messages WHERE conversation_id=$1 ORDER BY ordinal LIMIT 1000",
            [id],
          )
        ).map((m) => ({
          id: m.id,
          role: m.role,
          content: crypto.open(a.office.id, `message:${m.id}`, m.content_enc),
          model: m.model,
          createdAt: m.created_at,
        }));
      });
    },
    async remove(a: Access, id: string) {
      await db.office(a.office.id, async (q) => {
        const [c] = await q.query(
          "SELECT id FROM conversations WHERE id=$1 AND account_id=$2 FOR UPDATE",
          [id, a.account.id],
        );
        assert(c, 404, "conversation_not_found", "Conversation not found.");
        await q.query(
          "UPDATE requests SET response_enc=NULL,conversation_id=NULL WHERE conversation_id=$1",
          [id],
        );
        await q.query("DELETE FROM messages WHERE conversation_id=$1", [id]);
        await q.query("DELETE FROM conversations WHERE id=$1", [id]);
      });
      return { deleted: true, billingReceiptsRetained: true };
    },
  };
}
