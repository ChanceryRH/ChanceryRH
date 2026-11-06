import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, MEMBER } from "./fixture.ts";
import { seatLeaf } from "../server/chain.ts";
import { dollars } from "../shared/money.ts";
import { ZERO } from "../shared/chain.ts";
import { uid } from "../server/crypto.ts";
async function pending(r: any, o: any, credential: string) {
  const id = uid("seat_"),
    cap = dollars("50").toString();
  await r.db.office(o.id, (q: any) =>
    q.query(
      "INSERT INTO seats(id,office_id,credential,role,monthly_cap_pico,leaf) VALUES($1,$2,$3,'member',$4,$5)",
      [id, o.id, credential, cap, seatLeaf(credential, "member", cap, null)],
    ),
  );
  return id;
}
test("Seat approvals: only the named pending seat joins the active root", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const user = await r.login(),
    o = await r.office(user.account);
  const x = await pending(r, o, "wallet:" + MEMBER.address.toLowerCase()),
    y = await pending(r, o, "passkey:other-pending");
  const p = await r.offices.changeSeats(o.access, { seats: [{ id: y }] });
  const detail = await r.offices.proposal(o.access, p.id);
  assert.deepEqual(detail.payload.approvedSeatIds, [y]);
  assert(!detail.payload.seats.some((s: any) => s.id === x));
  r.chain.confirmedSafeTransaction = async () => true;
  o.snapshot.seatRoot = detail.payload.seatRoot;
  await r.offices.confirm(o.access, p.id, ZERO);
  const rows = await r.db.office(o.id, (q) =>
    q.query("SELECT id,status FROM seats"),
  );
  assert.equal(rows.find((s) => s.id === x).status, "pending");
  assert.equal(rows.find((s) => s.id === y).status, "active");
});
test("Seat approvals: old snapshots cannot be refreshed or restore a seat revoked after preparation", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const user = await r.login(),
    o = await r.office(user.account);
  const id = await pending(r, o, "passkey:revoked-seat");
  const p = await r.offices.changeSeats(o.access, { seats: [{ id }] });
  await assert.rejects(r.offices.refreshProposal(o.access, p.id), {
    code: "proposal_rebuild_required",
  });
  const d = await r.offices.proposal(o.access, p.id);
  o.snapshot.seatRoot = d.payload.seatRoot;
  r.chain.confirmedSafeTransaction = async () => true;
  await r.db.office(o.id, (q) =>
    q.query("UPDATE seats SET status='revoked',revoked_at=now() WHERE id=$1", [
      id,
    ]),
  );
  await assert.rejects(r.offices.confirm(o.access, p.id, ZERO), {
    code: "seat_state_changed",
  });
  assert.equal(
    (
      await r.db.office(o.id, (q) =>
        q.query("SELECT status FROM seats WHERE id=$1", [id]),
      )
    )[0].status,
    "revoked",
  );
});
test("Seat approvals: revoking then reinviting the same identity cannot revive an old approval", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const u = await r.login(),
    o = await r.office(u.account),
    member = await r.login(MEMBER);
  const invite = await r.offices.invite(o.access, {
    role: "member",
    monthlyCap: "50",
  });
  const claimed = await r.offices.claim(member.account, o.id, invite.token);
  const p = await r.offices.changeSeats(o.access, {
    seats: [{ id: claimed.seatId }],
  });
  const detail = await r.offices.proposal(o.access, p.id);
  await r.db.office(o.id, (q) =>
    q.query("UPDATE seats SET status='revoked',revoked_at=now() WHERE id=$1", [
      claimed.seatId,
    ]),
  );
  const again = await r.offices.invite(o.access, {
    role: "member",
    monthlyCap: "50",
  });
  await r.offices.claim(member.account, o.id, again.token);
  o.snapshot.seatRoot = detail.payload.seatRoot;
  r.chain.confirmedSafeTransaction = async () => true;
  await assert.rejects(r.offices.confirm(o.access, p.id, ZERO), {
    code: "seat_state_changed",
  });
  const [seat] = await r.db.office(o.id, (q) =>
    q.query("SELECT status FROM seats WHERE id=$1", [claimed.seatId]),
  );
  assert.equal(seat.status, "pending");
});
test("Seat approvals: legacy onboarding preserves only unchanged pending seats of current Safe owners", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const u = await r.login(),
    o = await r.office(u.account);
  const [prior] = await r.db.office(o.id, (q) =>
    q.query("SELECT * FROM seats"),
  );
  const seat = await r.db.office(o.id, async (q) => {
    await q.query("DELETE FROM seats");
    const [s] = await q.query(
      "INSERT INTO seats(id,office_id,account_id,credential,role,monthly_cap_pico,leaf) VALUES($1,$2,$3,$4,'principal',$5,$6) RETURNING *",
      [
        prior.id,
        o.id,
        u.account.id,
        prior.credential,
        prior.monthly_cap_pico,
        prior.leaf,
      ],
    );
    return s;
  });
  const p = await r.offices.propose(
    o.access,
    "open",
    [{ to: o.access.office.safe, data: "0x" }],
    { seatRoot: o.snapshot.seatRoot, seats: [seat] },
  );
  await r.db.office(o.id, (q) =>
    q.query(
      "UPDATE office_proposals SET payload=jsonb_set(payload,'{seats}',jsonb_build_array((payload->'seats'->0)-'authorization_version')) WHERE id=$1",
      [p.id],
    ),
  );
  r.chain.confirmedSafeTransaction = async () => true;
  const owners = o.snapshot.owners;
  o.snapshot.owners = [];
  await assert.rejects(r.offices.confirm(o.access, p.id, ZERO), {
    code: "seat_state_changed",
  });
  o.snapshot.owners = owners;
  assert.equal(
    (await r.offices.confirm(o.access, p.id, ZERO)).status,
    "confirmed",
  );
});
