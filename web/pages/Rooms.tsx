import { useEffect, useState } from "react";
import {
  ArrowUp,
  KeyRound,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useOffice } from "../App";
import { api, date, short } from "../api";
import {
  createRoomKey,
  wrapRoomKey,
  unwrapRoomKey,
  encryptRoomItem,
  decryptRoomItem,
} from "../../packages/client/room-crypto";
import {
  deviceFor,
  fingerprint,
  getStored,
  store,
  type Device,
} from "../room-store";
import { checkGuards } from "../../shared/guards";
import {
  Badge,
  Button,
  Empty,
  Feedback,
  Field,
  Modal,
  submit,
  useAction,
} from "../ui";
import { Pill, SidePanel, SideItem, SideSection, avatarStyle } from "../shell";
import { dayGroup, shortId, time } from "../data";
export function Rooms() {
  const { office, account } = useOffice(),
    action = useAction(),
    [device, setDevice] = useState<Device | null>(null),
    [rooms, setRooms] = useState<any[]>([]),
    [room, setRoom] = useState<any>(null),
    [directory, setDirectory] = useState<any>(null),
    [items, setItems] = useState<any[]>([]),
    [keys, setKeys] = useState<Map<number, Uint8Array>>(new Map()),
    [text, setText] = useState(""),
    [creating, setCreating] = useState(false),
    [retention, setRetention] = useState(30),
    [review, setReview] = useState<any>(null),
    [trusted, setTrusted] = useState(false),
    [member, setMember] = useState(""),
    [managing, setManaging] = useState(false),
    [deviceRemoved, setDeviceRemoved] = useState(false);
  const manager =
      room && (room.created_by === account.id || office.role === "principal"),
    guard = checkGuards(text);
  const deviceKey = `device:${account.id}:${office.id}`;
  async function loadRooms() {
    setRooms(await api.office(office.id, "/rooms"));
  }
  useEffect(() => {
    void action.run(async () => {
      const local = await deviceFor(account.id, office.id);
      const registered = await api.office(office.id, "/devices", {
        publicKey: local.publicKey,
      });
      local.id = registered.id;
      await store(deviceKey, local);
      setDevice(local);
      const rows = await api.office(office.id, "/rooms");
      setRooms(rows);
      if (rows[0]) await open(rows[0], local);
    });
  }, [office.id, account.id]);
  async function open(r: any, d = device) {
    if (!d?.id) throw new Error("Set up this device before opening a Room.");
    const [dir, wrapped, rows] = await Promise.all([
      api.office(office.id, `/rooms/${r.id}/devices`),
      api.office(office.id, `/rooms/${r.id}/keys/${d.id}`),
      api.office(office.id, `/rooms/${r.id}/items`),
    ]);
    const keyMap = new Map<number, Uint8Array>();
    for (const k of wrapped)
      keyMap.set(
        k.epoch,
        await unwrapRoomKey(
          k.wrapped_key,
          d.privateKey,
          office.id,
          r.id,
          k.epoch,
          d.id,
        ),
      );
    const decrypted = [];
    for (const item of [...rows].reverse()) {
      const key = keyMap.get(item.epoch);
      let content =
        "This device does not have the key for this earlier message.";
      if (key) {
        try {
          content = await decryptRoomItem(key, item, office.id, r.id);
        } catch {
          content =
            "This message could not be authenticated. It has not been displayed.";
        }
      }
      decrypted.push({ ...item, content });
    }
    setRoom(r);
    setDirectory(dir);
    setKeys(keyMap);
    setItems(decrypted);
    setText("");
  }
  async function reviewKeys(target = room) {
    if (!device?.id) throw new Error("This device is not registered.");
    const dir = await api.office(office.id, `/rooms/${target.id}/devices`);
    const own = await fingerprint(device.publicKey),
      pins =
        (await getStored<Record<string, string>>(
          `pins:${account.id}:${office.id}:${target.id}`,
        )) || {},
      recipients = [];
    for (const d of dir.devices) {
      const fp = await fingerprint(d.public_key);
      if (pins[d.id] && pins[d.id] !== fp)
        throw new Error(
          "A pinned device key changed. Verify the member’s device before continuing.",
        );
      if (d.id === device.id && fp !== own)
        throw new Error("Your device key does not match the directory.");
      recipients.push({
        ...d,
        fingerprint: fp,
        known: pins[d.id] === fp || d.id === device.id,
      });
    }
    setTrusted(recipients.every((r) => r.known));
    setReview({ room: target, directory: dir, recipients });
  }
  async function rotate() {
    const { room: target, directory: dir, recipients } = review;
    if (!trusted)
      throw new Error(
        "Verify the recipient device fingerprints before distributing a key.",
      );
    const fresh = await createRoomKey(),
      epoch = dir.epoch + 1,
      wrapped = [];
    for (const d of recipients)
      wrapped.push({
        deviceId: d.id,
        wrappedKey: await wrapRoomKey(
          fresh,
          d.public_key,
          office.id,
          target.id,
          epoch,
          d.id,
        ),
      });
    await api.office(office.id, `/rooms/${target.id}/rotate`, {
      expectedEpoch: dir.epoch,
      keys: wrapped,
    });
    const pins =
      (await getStored<Record<string, string>>(
        `pins:${account.id}:${office.id}:${target.id}`,
      )) || {};
    for (const d of recipients) pins[d.id] = d.fingerprint;
    await store(`pins:${account.id}:${office.id}:${target.id}`, pins);
    setReview(null);
    await loadRooms();
    await open(target);
    action.setNotice(
      "A fresh key is wrapped to the current devices. Earlier members retain any history they already received.",
    );
  }
  async function create() {
    const placeholder = Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (n) => n.toString(16).padStart(2, "0"),
    ).join("");
    const created = await api.office(office.id, "/rooms", {
      nameCiphertext: placeholder,
      retentionDays: retention,
      lanePolicy: "sealed",
    });
    const rows = await api.office(office.id, "/rooms");
    setRooms(rows);
    setCreating(false);
    const r = rows.find((x: any) => x.id === created.id);
    await open(r);
    await reviewKeys(r);
  }
  async function send() {
    if (guard) throw new Error(guard.message);
    const key = keys.get(directory.epoch);
    if (!key)
      throw new Error(
        "A Room manager needs to rotate the key to include this device.",
      );
    const item = await encryptRoomItem(
      key,
      text,
      office.id,
      room.id,
      directory.epoch,
      crypto.randomUUID(),
      account.id,
    );
    await api.office(office.id, `/rooms/${room.id}/items`, item);
    await open(room);
  }
  const guest = office.role === "guest";
  const roomName = (r: any) => `Room ${r.id.slice(-6)}`;
  const deviceCount = directory?.devices?.length || 0;
  const canWrite =
    !!directory && !directory.rotationRequired && keys.has(directory.epoch);
  const panel = (
    <SidePanel
      title="Rooms"
      action={
        <button
          className="icon-button"
          aria-label="Refresh Rooms"
          title="Refresh"
          disabled={action.busy}
          onClick={() => action.run(loadRooms)}
        >
          <RefreshCw size={15} />
        </button>
      }
    >
      {!guest && (
        <button
          className="side-new"
          disabled={!device?.id || deviceRemoved}
          onClick={() => setCreating(true)}
        >
          <Plus size={15} />
          New Room
        </button>
      )}
      <SideSection label="Your Rooms">
        {rooms.length ? (
          rooms.map((r) => (
            <SideItem
              key={r.id}
              active={room?.id === r.id}
              leading={<LockKeyhole size={15} />}
              title={roomName(r)}
              meta={`${r.retention_days}-day retention · ${dayGroup(r.created_at)}`}
              trailing={
                r.rotation_required ? (
                  <Pill tone="amber">Rotate key</Pill>
                ) : undefined
              }
              onClick={() => action.run(() => open(r))}
              disabled={deviceRemoved}
            />
          ))
        ) : (
          <p className="side-note">
            {action.busy && !device
              ? "Setting up this device…"
              : "Your encrypted spaces will appear here."}
          </p>
        )}
      </SideSection>
      <SideSection label="This device">
        <div className="device-card">
          <span className="device-line">
            <KeyRound size={14} />
            {deviceRemoved ? (
              "Revoked"
            ) : device?.id ? (
              <code title={device.id}>{shortId(device.id)}</code>
            ) : (
              "Registering…"
            )}
          </span>
          <div className="device-actions">
            <button
              className="link"
              onClick={() =>
                action.run(async () => {
                  await navigator.clipboard.writeText(account.id);
                  action.setNotice(
                    "Your account ID was copied. Share it with a Room manager to be added.",
                  );
                })
              }
            >
              Copy my account ID
            </button>
            <button
              className="link"
              disabled={!device?.id || deviceRemoved}
              onClick={() =>
                action.run(async () => {
                  action.setNotice(
                    `Device fingerprint: ${await fingerprint(device!.publicKey)}`,
                  );
                })
              }
            >
              Show fingerprint
            </button>
            <button
              className="link danger"
              disabled={!device?.id || deviceRemoved}
              onClick={() =>
                action.run(async () => {
                  await api.request(
                    `/offices/${office.id}/devices/${device!.id}`,
                    undefined,
                    "DELETE",
                  );
                  setDeviceRemoved(true);
                  setKeys(new Map());
                  setItems([]);
                })
              }
            >
              Revoke this device
            </button>
          </div>
        </div>
      </SideSection>
    </SidePanel>
  );
  if (deviceRemoved)
    return (
      <>
        {panel}
        <Feedback action={action} />
        <Empty title="This device has been revoked." icon={<KeyRound />}>
          Its server access is removed and affected Rooms require key rotation.
          Use another approved device to continue. This browser’s private key is
          retained locally; it will never be silently replaced.
        </Empty>
      </>
    );
  return (
    <div className="chat-page room-page">
      {panel}
      {room ? (
        <>
          <header className="chat-head">
            <div>
              <h1>{roomName(room)}</h1>
              <p className="room-meta">
                <Pill tone="ink">
                  <LockKeyhole size={11} /> Sealed
                </Pill>
                <span>Key epoch {directory?.epoch ?? room.epoch}</span>
                <span>
                  {deviceCount} device{deviceCount === 1 ? "" : "s"}
                </span>
                <span>{room.retention_days}-day retention</span>
              </p>
            </div>
            <div className="head-actions">
              <button
                className="icon-button"
                aria-label="Refresh Room"
                title="Refresh"
                disabled={action.busy}
                onClick={() => action.run(() => open(room))}
              >
                <RefreshCw size={15} />
              </button>
              {manager && (
                <Button kind="secondary" onClick={() => setManaging(true)}>
                  <Users size={14} />
                  Members
                </Button>
              )}
            </div>
          </header>
          <Feedback action={action} />
          {directory?.rotationRequired && (
            <div className="notice warning">
              <KeyRound size={16} />
              <span>
                Membership or devices changed. A manager must rotate the key
                before new messages can be sent.
              </span>
              {manager && (
                <Button
                  kind="secondary"
                  onClick={() => action.run(() => reviewKeys())}
                >
                  Rotate key
                </Button>
              )}
            </div>
          )}
          <div className={`chat-content ${items.length ? "has-messages" : ""}`}>
            {items.length ? (
              <div className="messages">
                {items.map((item) => {
                  const mine = item.account_id === account.id;
                  return (
                    <article key={item.id} className="message user">
                      <span
                        className="message-avatar tinted"
                        style={avatarStyle(mine && account.wallet ? account.wallet : item.account_id)}
                      >
                        {mine && account.wallet
                          ? account.wallet.slice(2, 4).toUpperCase()
                          : item.account_id
                              .replace(/^[a-z]+_/, "")
                              .slice(0, 2)
                              .toUpperCase()}
                      </span>
                      <div className="message-body">
                        <span className="message-author">
                          {mine ? "You" : short(item.account_id)}
                          <time>
                            {dayGroup(item.created_at)} ·{" "}
                            {time(item.created_at)}
                          </time>
                        </span>
                        <p className="room-text">{item.content}</p>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <Empty
                title="Keep this between yourselves."
                icon={<LockKeyhole />}
              >
                Only current members with the right device keys can read the
                conversation.
              </Empty>
            )}
          </div>
          <form
            className="composer-wrap"
            onSubmit={submit(() => action.run(send))}
          >
            <div className={`composer ${guard ? "blocked" : ""}`}>
              <textarea
                aria-label="Encrypted message"
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={60000}
                rows={2}
                disabled={!canWrite}
                placeholder={
                  canWrite
                    ? "Share a thought with your Room…"
                    : "Waiting for a key rotation that includes this device."
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (text.trim() && !guard && canWrite && !action.busy)
                      void action.run(send);
                  }
                }}
              />
              <div className="composer-controls">
                <span className="lane-label">
                  <ShieldCheck size={14} />
                  End-to-end encrypted · never sent to AI
                </span>
                {guard && (
                  <span className="guard-message">{guard.message}</span>
                )}
                <span className="composer-budget" />
                <Button
                  type="submit"
                  busy={action.busy}
                  disabled={!text.trim() || !!guard || !canWrite}
                >
                  Encrypt & send
                  <ArrowUp size={15} />
                </Button>
              </div>
            </div>
          </form>
        </>
      ) : (
        <>
          <Feedback action={action} />
          <Empty
            title={
              rooms.length
                ? "Choose a Room."
                : "A private space for shared thinking."
            }
            icon={<LockKeyhole />}
            action={
              !guest && !rooms.length ? (
                <Button
                  disabled={!device?.id}
                  onClick={() => setCreating(true)}
                >
                  <Plus size={15} />
                  New Room
                </Button>
              ) : undefined
            }
          >
            Room messages are encrypted on your device and stay encrypted from
            one member’s device to another. Sealed Rooms never send content to
            AI.
          </Empty>
        </>
      )}
      {creating && (
        <Modal
          title="Make a little private space."
          close={() => setCreating(false)}
        >
          <form onSubmit={submit(() => action.run(create))}>
            <Field
              label="Message retention · days"
              help="Expired ciphertext is removed. This cannot erase copies already received by members."
            >
              <input
                type="number"
                min="1"
                max="365"
                required
                value={retention}
                onChange={(e) => setRetention(Number(e.target.value))}
              />
            </Field>
            <p className="muted">
              New Rooms start sealed. Your device creates the encryption key;
              Chancery receives only wrapped keys and encrypted messages.
            </p>
            <Feedback action={action} />
            <Button type="submit" busy={action.busy}>
              Create sealed Room
            </Button>
          </form>
        </Modal>
      )}
      {review && (
        <Modal title="Review the Room’s devices" close={() => setReview(null)}>
          <p className="muted">
            Verify new device fingerprints with their owners through a trusted
            channel. A fresh key will be wrapped only to the devices listed
            below.
          </p>
          {review.recipients.map((d: any) => (
            <div className="device-row" key={d.id}>
              <strong>
                {d.account_id === account.id
                  ? "Your device"
                  : short(d.account_id)}
              </strong>
              <Badge>{d.known ? "Known device" : "New device"}</Badge>
              <code>{d.fingerprint}</code>
            </div>
          ))}
          <label className="check-row">
            <input
              type="checkbox"
              checked={trusted}
              onChange={(e) => setTrusted(e.target.checked)}
            />
            I recognize these recipients and have verified new devices.
          </label>
          <Feedback action={action} />
          <Button
            busy={action.busy}
            disabled={!trusted || !review.recipients.length}
            onClick={() => action.run(rotate)}
          >
            Rotate & distribute key
          </Button>
        </Modal>
      )}
      {managing && (
        <Modal title="Room membership" close={() => setManaging(false)}>
          <p className="muted">
            Add an active Office member using their account ID. Removing a
            member requires key rotation before the next message.
          </p>
          <form
            onSubmit={submit(() =>
              action.run(async () => {
                await api.office(office.id, `/rooms/${room.id}/members`, {
                  accountId: member,
                });
                await open(room);
                setMember("");
                setManaging(false);
                await reviewKeys();
              }),
            )}
          >
            <Field label="Member account ID">
              <input
                required
                value={member}
                onChange={(e) => setMember(e.target.value.trim())}
                placeholder="account_…"
              />
            </Field>
            <Button type="submit" busy={action.busy}>
              Add member
            </Button>
          </form>
          <div className="records-list">
            {[
              ...new Set<string>(
                directory?.devices.map((d: any) => d.account_id),
              ),
            ].map((id) => (
              <div className="section-heading" key={id}>
                <code>{id}</code>
                {id !== account.id && (
                  <Button
                    kind="danger"
                    onClick={() =>
                      action.run(async () => {
                        await api.office(
                          office.id,
                          `/rooms/${room.id}/members`,
                          { accountId: id, remove: true },
                        );
                        await open(room);
                        setManaging(false);
                        await reviewKeys();
                      })
                    }
                  >
                    Remove
                  </Button>
                )}
              </div>
            ))}
          </div>
          <Feedback action={action} />
        </Modal>
      )}
    </div>
  );
}
