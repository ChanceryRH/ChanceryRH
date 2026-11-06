import { useEffect, useState } from "react";
import {
  ArrowRight,
  Copy,
  Plus,
  Search,
  ShieldCheck,
  Users,
  UserCheck,
  UserRoundX,
} from "lucide-react";
import { useOffice } from "../App";
import { api, short, money, date, type Receipt } from "../api";
import {
  Amount,
  Monogram,
  Pill,
  Progress,
  SidePanel,
  SideItem,
  SideSection,
} from "../shell";
import {
  charged,
  modelLabel,
  sentence,
  monthLabel,
  payload,
  receiptState,
  sum,
  thisMonth,
} from "../data";
import {
  Button,
  Empty,
  Feedback,
  Field,
  Modal,
  Panel,
  submit,
  useAction,
} from "../ui";
const roleName = (role: string) =>
  ({
    principal: "Owner",
    officer: "Officer",
    member: "Member",
    guest: "Guest",
  })[role] || role;
export function People() {
  const { office, onProposal, navigate, models } = useOffice(),
    action = useAction(),
    [seats, setSeats] = useState<any[]>([]),
    [inviteOpen, setInviteOpen] = useState(false),
    [invite, setInvite] = useState<any>(null),
    [role, setRole] = useState("member"),
    [cap, setCap] = useState("50"),
    [editing, setEditing] = useState<any>(null),
    [query, setQuery] = useState(""),
    [tab, setTab] = useState<"seats" | "pending">("seats"),
    [selectedId, setSelectedId] = useState(""),
    [receipts, setReceipts] = useState<Receipt[]>([]);
  const names = new Map(models.map((m) => [m.id, m.name]));
  const principal = office.role === "principal",
    manager = principal || office.role === "officer";
  async function load() {
    setSeats(await api.office(office.id, "/seats"));
  }
  useEffect(() => {
    if (manager) void action.run(load);
    if (manager && office.status === "active")
      void api
        .office(office.id, `/ledger?month=${thisMonth()}`)
        .then(setReceipts)
        .catch(() => {});
  }, [office.id, office.status]);
  useEffect(() => {
    if (
      location.hash.includes("invite") &&
      manager &&
      office.status === "active"
    ) {
      setInvite(null);
      setInviteOpen(true);
      history.replaceState(null, "", "#/people");
    }
  }, []);
  if (!manager)
    return (
      <>
        <SidePanel title="People" />
        <Empty icon={<Users />} title="Your team, in good hands.">
          Office owners and Officers manage invitations. Contact them if your
          access needs to change.
        </Empty>
      </>
    );
  async function propose(change: any) {
    await api.office(office.id, "/seats/propose", { seats: [change] });
    setEditing(null);
    await onProposal();
  }
  const label = (s: any) =>
    s.credential?.startsWith("wallet:")
      ? short(s.credential.slice(7))
      : "Passkey member";
  const shown = seats.filter(
    (s) =>
      (tab === "pending" ? s.status === "pending" : s.status !== "pending") &&
      (!query ||
        `${label(s)} ${s.role} ${s.credential}`
          .toLowerCase()
          .includes(query.toLowerCase())),
  );
  const seat = seats.find((s) => s.id === selectedId) || shown[0];
  const seatReceipts = receipts.filter((r) => payload(r).actorId === seat?.id);
  const seatCap = seat ? Number(seat.monthly_cap_pico) / 1e12 : 0;
  const seatUsed = sum(seatReceipts);
  return (
    <>
      <SidePanel
        title="People"
        action={
          <Button
            kind="secondary"
            className="small"
            onClick={() => {
              setInvite(null);
              setInviteOpen(true);
            }}
            disabled={office.status !== "active"}
            aria-label="Invite a teammate"
          >
            <Plus size={14} /> Invite
          </Button>
        }
      >
        <label className="side-search">
          <Search size={14} />
          <input
            placeholder="Search members…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="segmented">
          <button
            className={tab === "seats" ? "active" : ""}
            onClick={() => setTab("seats")}
          >
            Seats{" "}
            <span className="count">
              {seats.filter((s) => s.status !== "pending").length}
            </span>
          </button>
          <button
            className={tab === "pending" ? "active" : ""}
            onClick={() => setTab("pending")}
          >
            Pending{" "}
            <span className="count">
              {seats.filter((s) => s.status === "pending").length}
            </span>
          </button>
        </div>
        <SideSection>
          {shown.length ? (
            shown.map((s) => (
              <SideItem
                key={s.id}
                active={seat?.id === s.id}
                leading={<Monogram value={s.credential?.slice(7) || s.id} />}
                title={label(s)}
                meta={<span className="capitalize">{roleName(s.role)}</span>}
                trailing={
                  s.status !== "active" ? (
                    <Pill tone={s.status === "pending" ? "amber" : "red"}>
                      {sentence(s.status)}
                    </Pill>
                  ) : undefined
                }
                onClick={() => setSelectedId(s.id)}
              />
            ))
          ) : (
            <p className="side-note">
              {tab === "pending"
                ? "No seats waiting for approval."
                : "No members match."}
            </p>
          )}
        </SideSection>
      </SidePanel>
      <Feedback action={action} />
      {!seat ? (
        <Empty icon={<Users />} title="Bring your people in.">
          Invite a teammate to give them a seat with its own spending limit.
        </Empty>
      ) : (
        <div className="detail-page">
          <header className="profile-head">
            <Monogram
              value={seat.credential?.slice(7) || seat.id}
              tone="large"
            />
            <div>
              <h1>{label(seat)}</h1>
              <p>
                <code>
                  {seat.credential?.startsWith("wallet:")
                    ? seat.credential.slice(7)
                    : seat.id}
                </code>
              </p>
            </div>
            <Pill tone="ink">{roleName(seat.role)}</Pill>
            <Pill
              tone={
                seat.status === "active"
                  ? "green"
                  : seat.status === "pending"
                    ? "amber"
                    : "red"
              }
            >
              {sentence(seat.status)}
            </Pill>
            <span className="grow" />
            {principal &&
              office.status === "active" &&
              seat.status !== "revoked" && (
                <>
                  {seat.status === "pending" && (
                    <Button
                      disabled={action.busy}
                      onClick={() => action.run(() => propose({ id: seat.id }))}
                    >
                      <UserCheck size={14} />
                      Approve this seat
                    </Button>
                  )}
                  {seat.role !== "principal" && (
                    <Button
                      kind="secondary"
                      onClick={() =>
                        setEditing({
                          ...seat,
                          newRole: seat.role,
                          newCap: String(Number(seat.monthly_cap_pico) / 1e12),
                        })
                      }
                    >
                      Manage seat
                    </Button>
                  )}
                </>
              )}
          </header>
          <Panel className="card">
            <div className="card-head">
              <div>
                <h2>Seat limit</h2>
                <p>Per 30-day cycle · changes need Safe approval</p>
              </div>
              <div className="card-figure">
                <strong>{money(seatCap)} USDG</strong>
                <small>
                  {money(seatUsed)} spent in {monthLabel(thisMonth())}
                </small>
              </div>
            </div>
            <Progress value={seatUsed} max={seatCap} />
          </Panel>
          <Panel className="card">
            <div className="card-head">
              <div>
                <h2>Recent receipts</h2>
                <p>{monthLabel(thisMonth())}</p>
              </div>
              <button className="link" onClick={() => navigate("ledger")}>
                Open ledger <ArrowRight size={13} />
              </button>
            </div>
            {seatReceipts.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Model</th>
                    <th className="num">Cost (USDG)</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {seatReceipts.slice(0, 8).map((r) => {
                    const st = receiptState(r);
                    return (
                      <tr key={r.id}>
                        <td>{date(r.created_at)}</td>
                        <td>{modelLabel(r, names)}</td>
                        <td className="num">
                          <Amount value={charged(r)} />
                        </td>
                        <td>
                          <Pill tone={st.tone}>{st.label}</Pill>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="card-empty">
                No receipts for this seat this month.
              </p>
            )}
          </Panel>
          <div className="safe-strip">
            <ShieldCheck size={16} />
            <span>
              Seat changes take effect after the Safe’s approval is executed.
              Each active seat costs 9 USDG per calendar month, prorated daily.
            </span>
            {principal && seat.account_id && (
              <button
                className="link"
                onClick={() =>
                  action.run(async () => {
                    await navigator.clipboard.writeText(seat.account_id);
                    action.setNotice("Member account ID copied.");
                  })
                }
              >
                <Copy size={12} /> Copy account ID
              </button>
            )}
          </div>
        </div>
      )}
      {inviteOpen && (
        <Modal
          title={invite ? "Your invitation is ready." : "Bring someone in."}
          close={() => setInviteOpen(false)}
        >
          {invite ? (
            <>
              <p className="muted">
                Share these details privately. The invitation expires{" "}
                {new Date(invite.expiresAt).toLocaleString()}. Your Safe must
                approve the seat after it is claimed.
              </p>
              <Field label="Office ID">
                <input readOnly value={invite.officeId} />
              </Field>
              <Field label="Invitation code">
                <input readOnly value={invite.token} />
              </Field>
              <Button
                kind="secondary"
                onClick={() =>
                  action.run(async () => {
                    await navigator.clipboard.writeText(
                      `Office ID: ${invite.officeId}\nInvitation code: ${invite.token}`,
                    );
                    action.setNotice("Invitation copied.");
                  })
                }
              >
                <Copy size={16} />
                Copy invitation
              </Button>
              <Feedback action={action} />
            </>
          ) : (
            <form
              onSubmit={submit(() =>
                action.run(async () =>
                  setInvite(
                    await api.office(office.id, "/invites", {
                      role,
                      monthlyCap: cap,
                      expiresInHours: 48,
                    }),
                  ),
                ),
              )}
            >
              <Field label="Role">
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="member">Member · use the workspace</option>
                  {principal && (
                    <option value="officer">
                      Officer · manage invites and approvals
                    </option>
                  )}
                </select>
              </Field>
              <Field label="Seat spending limit · USDG per cycle">
                <input
                  type="number"
                  required
                  min="0"
                  max="5000"
                  step="0.01"
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                />
              </Field>
              <Feedback action={action} />
              <Button busy={action.busy} type="submit">
                Create 48-hour invitation
              </Button>
            </form>
          )}
        </Modal>
      )}
      {editing && (
        <Modal title="Manage seat" close={() => setEditing(null)}>
          <form
            onSubmit={submit(() =>
              action.run(() =>
                propose({
                  id: editing.id,
                  role: editing.newRole,
                  monthlyCap: editing.newCap,
                }),
              ),
            )}
          >
            <Field label="Role">
              <select
                value={editing.newRole}
                onChange={(e) =>
                  setEditing({ ...editing, newRole: e.target.value })
                }
              >
                <option value="member">Member</option>
                <option value="officer">Officer</option>
                {editing.role === "guest" && (
                  <option value="guest">Guest</option>
                )}
              </select>
            </Field>
            <Field label="Spending limit · USDG">
              <input
                type="number"
                min="0"
                max="5000"
                required
                step="0.01"
                value={editing.newCap}
                onChange={(e) =>
                  setEditing({ ...editing, newCap: e.target.value })
                }
              />
            </Field>
            <Feedback action={action} />
            <div className="actions">
              <Button busy={action.busy} type="submit">
                Propose change
              </Button>
              <Button
                type="button"
                kind="danger"
                disabled={action.busy}
                onClick={() =>
                  action.run(() => propose({ id: editing.id, revoke: true }))
                }
              >
                <UserRoundX size={15} />
                Propose removal
              </Button>
            </div>
            <p className="panel-note">
              Removal requires Safe approval and triggers Room key rotation.
            </p>
          </form>
        </Modal>
      )}
    </>
  );
}
