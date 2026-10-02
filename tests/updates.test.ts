import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, chat, MEMBER } from "./fixture.ts";
import {
  createDevice,
  createRoomKey,
  wrapRoomKey,
  unwrapRoomKey,
  encryptRoomItem,
  decryptRoomItem,
} from "../packages/client/room-crypto.ts";
import { uid } from "../server/crypto.ts";
import { dollars } from "../shared/money.ts";
test("Rooms: per-device wrapping, authenticated context, and revocation require rotation", async (t) => {
  const r = await fixture("rooms");
  t.after(() => r.db.close());
  const user = await r.login(),
    o = await r.office(user.account),
    device = await createDevice(),
    registered = await r.rooms.device(o.access, {
      publicKey: device.publicKey,
    }),
    room = await r.rooms.create(o.access, {
      nameCiphertext: "ZW5jcnlwdGVk",
      lanePolicy: "sealed",
    }),
    key = await createRoomKey();
  const wrapped = await wrapRoomKey(
    key,
    device.publicKey,
    o.id,
    room.id,
    2,
    registered.id,
  );
  await r.rooms.rotate(o.access, room.id, {
    expectedEpoch: 1,
    keys: [{ deviceId: registered.id, wrappedKey: wrapped }],
  });
  const decoded = await unwrapRoomKey(
    wrapped,
    device.privateKey,
    o.id,
    room.id,
    2,
    registered.id,
  );
  assert.deepEqual(decoded, key);
  await assert.rejects(
    unwrapRoomKey(wrapped, device.privateKey, o.id, room.id, 3, registered.id),
  );
  const item = await encryptRoomItem(
    key,
    "Private room content",
    o.id,
    room.id,
    2,
    uid("item_"),
    user.account.id,
  );
  await r.rooms.post(o.access, room.id, item);
  const [saved] = await r.rooms.items(o.access, room.id);
  assert.equal(
    await decryptRoomItem(key, saved, o.id, room.id),
    "Private room content",
  );
  await assert.rejects(
    decryptRoomItem(
      key,
      { ...saved, account_id: "someone-else" },
      o.id,
      room.id,
    ),
  );
  await r.rooms.revokeDevice(o.access, registered.id);
  await assert.rejects(
    r.rooms.post(o.access, room.id, { ...item, id: uid("item_") }),
    { code: "rotation_required" },
  );
  await assert.rejects(r.rooms.keys(o.access, room.id, registered.id), {
    code: "device_denied",
  });
  const [row] = await r.db.office(o.id, (q) =>
    q.query("SELECT * FROM room_items"),
  );
  assert(!JSON.stringify(row).includes("Private room content"));
});



