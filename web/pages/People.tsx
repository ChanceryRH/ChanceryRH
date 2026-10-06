import { useEffect, useState } from "react";
import { Copy, Plus, Users, UserCheck, UserRoundX } from "lucide-react";
import { useOffice } from "../App";
import { api, short, money } from "../api";
import {
  Badge,
  Button,
  Empty,
  Feedback,
  Field,
  Modal,
  PageTitle,
  Panel,
  submit,
  useAction,
} from "../ui";
export function People() {
  const { office, onProposal } = useOffice(),
    action = useAction(),
    [seats, setSeats] = useState<any[]>([]),
    [inviteOpen, setInviteOpen] = useState(false),
    [invite, setInvite] = useState<any>(null),
    [role, setRole] = useState("member"),
    [cap, setCap] = useState("50"),
    [editing, setEditing] = useState<any>(null);
  const principal = office.role === "principal",
    manager = principal || office.role === "officer";
  async function load() {
    setSeats(await api.office(office.id, "/seats"));
  }
  useEffect(() => {
    if (manager) void action.run(load);
  }, [office.id, office.status]);
  if (!manager)
    return (
      <Empty icon={<Users />} title="Your team, in good hands.">
        Office owners and Officers manage invitations. Contact them if your
        access needs to change.
      </Empty>
    );
  async function propose(change: any) {
    await api.office(office.id, "/seats/propose", { seats: [change] });
    setEditing(null);
    await onProposal();
  }
  return (
    <>
      <PageTitle
        eyebrow="GOOD COMPANY"
        title="A place for your people."
        actions={
          <Button
            onClick={() => {
              setInvite(null);
              setInviteOpen(true);
            }}
            disabled={office.status !== "active"}
          >
            <Plus size={17} />
            Invite a teammate
          </Button>
        }
      >
        Roles and spending limits keep everyone on the same page.
      </PageTitle>
      <Feedback action={action} />
      <Panel>
        <div className="section-heading">
          <h2>Office seats</h2>
          <Badge>
            {seats.filter((s) => s.status === "active").length} active
          </Badge>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Seat limit · USDG</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {seats.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="person-name">
                      <span className="account-avatar">
                        <Users size={15} />
                      </span>
                      <span>
                        {s.credential.startsWith("wallet:")
                          ? short(s.credential.slice(7))
                          : "Passkey member"}
                        <small>{short(s.id)}</small>
                      </span>
                    </span>
                  </td>
                  <td className="capitalize">{s.role}</td>
                  <td>{money(Number(s.monthly_cap_pico) / 1e12)}</td>
                  <td>
                    <Badge tone={s.status === "active" ? "green" : ""}>
                      {s.status}
                    </Badge>
                  </td>
                  <td>
                    {principal && s.account_id && (
                      <button
                        className="text-button"
                        title="Copy account ID for Room membership"
                        onClick={() =>
                          action.run(async () => {
                            await navigator.clipboard.writeText(s.account_id);
                            action.setNotice("Member account ID copied.");
                          })
                        }
                      >
                        <Copy size={12} />
                        Account ID
                      </button>
                    )}
                    {principal &&
                      office.status === "active" &&
                      s.status !== "revoked" && (
                        <div className="actions">
                          {s.status === "pending" && (
                            <Button
                              kind="secondary"
                              disabled={action.busy}
                              onClick={() =>
                                action.run(() => propose({ id: s.id }))
                              }
                            >
                              <UserCheck size={14} />
                              Approve seat
                            </Button>
                          )}
                          {s.role !== "principal" && (
                            <button
                              className="text-button"
                              onClick={() =>
                                setEditing({
                                  ...s,
                                  newRole: s.role,
                                  newCap: String(
                                    Number(s.monthly_cap_pico) / 1e12,
                                  ),
                                })
                              }
                            >
                              Manage
                            </button>
                          )}
                        </div>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="panel-note">
          Seat changes take effect after the Safe’s approval is executed. Each
          active seat costs 9 USDG per calendar month, prorated daily.
        </p>
      </Panel>
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
