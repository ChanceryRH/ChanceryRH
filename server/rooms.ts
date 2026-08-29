import { z } from "zod";
import { uid, hash, canonicalJson, type CryptoService } from "./crypto.ts";
import { assert } from "./errors.ts";
import type { Database, Query } from "./db.ts";
import type { Access } from "./offices.ts";
const keySchema = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  ext: z.boolean().optional(),
  key_ops: z.array(z.string()).max(3).optional(),
});
const b64 = z.string().regex(/^[A-Za-z0-9_-]+$/);
const wrappedSchema = z.strictObject({
  ephemeralPublicKey: keySchema,
  nonce: b64.length(16),
  ciphertext: b64.min(60).max(1000),
});
export function createRooms(db: Database, crypto: CryptoService) {
  async function membership(q: Query, a: Access, id: string, write = false) {
    const [room] = await q.query("SELECT * FROM rooms WHERE id=$1 FOR UPDATE", [
      id,
    ]);
    assert(room, 404, "room_not_found", "Room not found.");
    const [member] = await q.query(
      "SELECT * FROM room_members WHERE room_id=$1 AND account_id=$2 AND removed_at IS NULL AND (expires_at IS NULL OR expires_at>now())",
      [id, a.account.id],
    );
    assert(
      member,
      403,
      "room_access_denied",
      "You are not a current member of this Room.",
    );
    const expired = await q.query(
      "UPDATE room_members SET removed_at=now() WHERE room_id=$1 AND removed_at IS NULL AND expires_at<=now() RETURNING account_id",
      [id],
    );
    if (expired.length) {
      room.rotation_required = true;
      await q.query("UPDATE rooms SET rotation_required=true WHERE id=$1", [
        id,
      ]);
    }
    if (write)
      assert(
        !room.rotation_required,
        409,
        "rotation_required",
        "Rotate the Room key before posting.",
      );
    return room;
  }
  async function manager(q: Query, a: Access, id: string) {
    const room = await membership(q, a, id);
    assert(
      a.role === "principal" || room.created_by === a.account.id,
      403,
      "room_manager_required",
      "A Room creator or member who is a Principal must manage this Room.",
    );
    return room;
  }
  async function device(a: Access, body: unknown) {
    const input = z.strictObject({ publicKey: keySchema }).parse(body);
    assert(
      a.role !== "guest" || a.seat.expires_at,
      403,
      "seat_invalid",
      "Guest seat must expire.",
    );
    await cryptoKey(input.publicKey);
    const id = `device_${hash(canonicalJson({ kty: "EC", crv: "P-256", x: input.publicKey.x, y: input.publicKey.y })).slice(0, 40)}`;
    await db.office(a.office.id, async (q) => {
      const [existing] = await q.query("SELECT * FROM devices WHERE id=$1", [
        id,
      ]);
      if (existing) {
        assert(
          existing.account_id === a.account.id && !existing.revoked_at,
          409,
          "device_conflict",
          "This device key cannot be reused.",
        );
        return;
      }
      await q.query(
        "INSERT INTO devices(id,office_id,account_id,public_key) VALUES($1,$2,$3,$4)",
        [id, a.office.id, a.account.id, JSON.stringify(input.publicKey)],
      );
      await q.query(
        "UPDATE rooms SET rotation_required=true WHERE id IN(SELECT room_id FROM room_members WHERE account_id=$1 AND removed_at IS NULL)",
        [a.account.id],
      );
    });
    return { id };
  }
  async function cryptoKey(key: any) {
    try {
      await globalThis.crypto.subtle.importKey(
        "jwk",
        key,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        [],
      );
    } catch {
      assert(
        false,
        400,
        "key_invalid",
        "Device key is not a valid P-256 public key.",
      );
    }
  }
  async function create(a: Access, body: unknown) {
    assert(a.role !== "guest", 403, "room_only", "Guests cannot create Rooms.");
    const input = z
        .strictObject({
          nameCiphertext: b64.max(4000),
          retentionDays: z.number().int().min(1).max(365).default(30),
          lanePolicy: z
            .enum(["standard", "zero_retention", "sealed"])
            .default("sealed"),
        })
        .parse(body),
      id = uid("room_");
    await db.office(a.office.id, async (q) => {
      await q.query(
        "INSERT INTO rooms(id,office_id,name_enc,retention_days,lane_policy,rotation_required,created_by) VALUES($1,$2,$3,$4,$5,true,$6)",
        [
          id,
          a.office.id,
          input.nameCiphertext,
          input.retentionDays,
          input.lanePolicy,
          a.account.id,
        ],
      );
      await q.query(
        "INSERT INTO room_members(office_id,room_id,account_id) VALUES($1,$2,$3)",
        [a.office.id, id, a.account.id],
      );
    });
    return { id, epoch: 1, rotationRequired: true };
  }
  async function members(a: Access, id: string, body: unknown) {
    const input = z
      .strictObject({
        accountId: z.string().max(100),
        remove: z.boolean().default(false),
        expiresAt: z.iso.datetime().optional(),
      })
      .parse(body);
    return db.office(a.office.id, async (q) => {
      await manager(q, a, id);
      if (input.remove) {
        await q.query(
          "UPDATE room_members SET removed_at=now() WHERE room_id=$1 AND account_id=$2",
          [id, input.accountId],
        );
      } else {
        const [seat] = await q.query(
          "SELECT * FROM seats WHERE account_id=$1 AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())",
          [input.accountId],
        );
        assert(seat, 400, "seat_required", "Add an active Office seat first.");
        if (seat.role === "guest") {
          const [invite] = await q.query(
            "SELECT room_id FROM invites WHERE claimed_by=$1 AND room_id=$2",
            [input.accountId, id],
          );
          assert(
            invite,
            403,
            "guest_room_only",
            "Guests can join only their invited Room.",
          );
        }
        let expires = input.expiresAt || null;
        if (
          seat.expires_at &&
          (!expires || new Date(expires) > new Date(seat.expires_at))
        )
          expires = new Date(seat.expires_at).toISOString();
        assert(
          !expires || new Date(expires).getTime() > Date.now(),
          400,
          "expiry_invalid",
          "Membership expiry must be in the future.",
        );
        await q.query(
          "INSERT INTO room_members(office_id,room_id,account_id,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(room_id,account_id) DO UPDATE SET expires_at=excluded.expires_at,removed_at=NULL",
          [a.office.id, id, input.accountId, expires],
        );
      }
      await q.query("UPDATE rooms SET rotation_required=true WHERE id=$1", [
        id,
      ]);
      return { rotationRequired: true };
    });
  }
  async function directory(a: Access, id: string) {
    return db.office(a.office.id, async (q) => {
      const room = await membership(q, a, id);
      const devices = await q.query(
        "SELECT d.id,d.account_id,d.public_key FROM devices d JOIN room_members m ON m.account_id=d.account_id WHERE m.room_id=$1 AND m.removed_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>now()) AND d.revoked_at IS NULL ORDER BY d.id",
        [id],
      );
      return {
        epoch: room.epoch,
        rotationRequired: room.rotation_required,
        devices,
      };
    });
  }
  async function rotate(a: Access, id: string, body: unknown) {
    const input = z
      .strictObject({
        expectedEpoch: z.number().int().positive(),
        keys: z
          .array(
            z.strictObject({
              deviceId: z.string().max(100),
              wrappedKey: wrappedSchema,
            }),
          )
          .min(1)
          .max(1000),
      })
      .parse(body);
    return db.office(a.office.id, async (q) => {
      const room = await manager(q, a, id);
      assert(
        room.epoch === input.expectedEpoch,
        409,
        "epoch_changed",
        "The Room epoch changed. Refresh its device directory.",
      );
      const devices = await q.query(
        "SELECT d.id FROM devices d JOIN room_members m ON m.account_id=d.account_id WHERE m.room_id=$1 AND m.removed_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>now()) AND d.revoked_at IS NULL ORDER BY d.id",
        [id],
      );
      const supplied = input.keys.map((k) => k.deviceId).sort();
      assert(
        canonicalJson(supplied) === canonicalJson(devices.map((d) => d.id)),
        400,
        "keys_incomplete",
        "Wrap the new key exactly once for every current device.",
      );
      const epoch = room.epoch + 1;
      for (const key of input.keys) {
        await cryptoKey(key.wrappedKey.ephemeralPublicKey);
        await q.query(
          "INSERT INTO room_keys(office_id,room_id,epoch,device_id,wrapped_key) VALUES($1,$2,$3,$4,$5)",
          [
            a.office.id,
            id,
            epoch,
            key.deviceId,
            JSON.stringify(key.wrappedKey),
          ],
        );
      }
      await q.query(
        "UPDATE rooms SET epoch=$1,rotation_required=false WHERE id=$2",
        [epoch, id],
      );
      return { epoch };
    });
  }
  async function keys(a: Access, id: string, deviceId: string) {
    return db.office(a.office.id, async (q) => {
      await membership(q, a, id);
      const [d] = await q.query(
        "SELECT id FROM devices WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL",
        [deviceId, a.account.id],
      );
      assert(d, 403, "device_denied", "This is not your active device.");
      return q.query(
        "SELECT epoch,wrapped_key FROM room_keys WHERE room_id=$1 AND device_id=$2 ORDER BY epoch",
        [id, deviceId],
      );
    });
  }
  async function post(a: Access, id: string, body: unknown) {
    const input = z
      .strictObject({
        id: z.string().regex(/^[a-zA-Z0-9_-]{16,100}$/),
        epoch: z.number().int().positive(),
        ciphertext: b64.min(22).max(300000),
        nonce: b64.length(16),
      })
      .parse(body);
    return db.office(a.office.id, async (q) => {
      const room = await membership(q, a, id, true);
      assert(
        input.epoch === room.epoch,
        409,
        "epoch_changed",
        "Encrypt with the current Room key.",
      );
      const [prior] = await q.query("SELECT * FROM room_items WHERE id=$1", [
        input.id,
      ]);
      if (prior) {
        assert(
          prior.room_id === id &&
            prior.account_id === a.account.id &&
            prior.ciphertext === input.ciphertext &&
            prior.nonce === input.nonce &&
            prior.epoch === input.epoch,
          409,
          "item_conflict",
          "Message ID is already in use.",
        );
        return { id: input.id };
      }
      await q.query(
        "INSERT INTO room_items(id,office_id,room_id,epoch,account_id,ciphertext,nonce,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          input.id,
          a.office.id,
          id,
          input.epoch,
          a.account.id,
          input.ciphertext,
          input.nonce,
          new Date(Date.now() + room.retention_days * 86400000).toISOString(),
        ],
      );
      return { id: input.id };
    });
  }
  return {
    device,
    create,
    members,
    directory,
    rotate,
    keys,
    post,
    async list(a: Access) {
      return db.office(a.office.id, (q) =>
        q.query(
          "SELECT r.* FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE m.account_id=$1 AND m.removed_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>now())",
          [a.account.id],
        ),
      );
    },
    async items(a: Access, id: string) {
      return db.office(a.office.id, async (q) => {
        await membership(q, a, id);
        return q.query(
          "SELECT id,epoch,account_id,ciphertext,nonce,created_at FROM room_items WHERE room_id=$1 AND expires_at>now() ORDER BY created_at DESC LIMIT 200",
          [id],
        );
      });
    },
    
  };
}
