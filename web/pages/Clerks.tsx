import { useEffect, useState } from "react";
import {
  Bot,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useOffice } from "../App";
import { api, date, money, errorText, ChanceryError } from "../api";
import { checkGuards } from "../../shared/guards";
import {
  Badge,
  Button,
  Empty,
  Feedback,
  Field,
  JsonDetails,
  Modal,
  PageTitle,
  Panel,
  submit,
  useAction,
} from "../ui";
export function Clerks({ initialDraft = false }: { initialDraft?: boolean }) {
  const { office, account, models, config, onProposal } = useOffice(),
    action = useAction(),
    [rows, setRows] = useState<any[]>([]),
    [approvals, setApprovals] = useState<any[]>([]),
    [creating, setCreating] = useState(false),
    [prepared, setPrepared] = useState<any>(null),
    [outcome, setOutcome] = useState<any>(null),
    [draft, setDraft] = useState<any>(null);
  const manager = ["principal", "officer"].includes(office.role),
    principal = office.role === "principal",
    drafts = config.updates.some((u) => u.id === "safe_drafts" && u.enabled);
  const [name, setName] = useState(""),
    [job, setJob] = useState(""),
    [model, setModel] = useState(models[0]?.id || ""),
    [cap, setCap] = useState("50"),
    [perRequest, setPerRequest] = useState("1"),
    [hour, setHour] = useState("2"),
    [day, setDay] = useState("10"),
    [week, setWeek] = useState("25"),
    [ask, setAsk] = useState("0"),
    [schedule, setSchedule] = useState("");
  const [to, setTo] = useState(""),
    [data, setData] = useState("0x"),
    [value, setValue] = useState("0"),
    [explanation, setExplanation] = useState("");
  async function load() {
    const [c, a] = await Promise.all([
      api.office(office.id, "/clerks"),
      api.office(office.id, "/approvals"),
    ]);
    setRows(c);
    setApprovals(a);
  }
  useEffect(() => {
    if (manager) void action.run(load);
  }, [office.id]);
  async function prepare(id: string, chat?: any) {
    const p = await api.office(
      office.id,
      `/clerks/${id}/prepare`,
      chat ? { chat } : {},
    );
    setPrepared({
      ...p,
      clerkId: id,
      requestId: crypto.randomUUID(),
      approved: p.decision === "allow",
    });
    await load();
  }
  async function run() {
    const p = prepared;
    setPrepared({ ...p, sent: true });
    setOutcome({ status: "pending", id: p.requestId });
    try {
      const response = await api.office(office.id, `/clerks/${p.clerkId}/run`, {
        id: p.requestId,
        quoteId: p.quote.id,
        chat: p.chat,
        ...(p.approvalId ? { approvalId: p.approvalId } : {}),
      });
      setOutcome(response);
      if (response.status === "complete" || response.status === "failed") {
        sessionStorage.removeItem(`chancery:clerk:${account.id}:${office.id}`);
        setPrepared(null);
      }
      await load();
    } catch (error) {
      if (
        error instanceof ChanceryError &&
        ((error.status >= 400 &&
          error.status < 500 &&
          error.code !== "idempotency_conflict") ||
          error.code === "provider_unconfigured")
      ) {
        sessionStorage.removeItem(`chancery:clerk:${account.id}:${office.id}`);
        setOutcome({
          status: "failed",
          id: p.requestId,
          error: errorText(error),
        });
        setPrepared(null);
      } else setOutcome({ status: "unconfirmed", id: p.requestId });
      throw error;
    }
  }
  useEffect(() => {
    const saved = sessionStorage.getItem(
      `chancery:clerk:${account.id}:${office.id}`,
    );
    if (saved) setOutcome({ status: "unconfirmed", id: saved });
  }, [office.id]);
  if (!manager)
    return (
      <Empty title="Your Officers look after the Clerks." icon={<Bot />}>
        Ask an Officer or Safe owner to create a Clerk or review its work.
      </Empty>
    );
  return (
    <>
      <PageTitle
        eyebrow="A JOB. A RULEBOOK. AN ALLOWANCE."
        title="A little help. Clear boundaries."
        actions={
          <>
            <Button
              kind="secondary"
              onClick={() => action.run(load)}
              busy={action.busy}
            >
              <RefreshCw size={15} />
            </Button>
            {principal && (
              <Button onClick={() => setCreating(true)}>
                <Plus size={16} />
                New Clerk
              </Button>
            )}
          </>
        }
      >
        Scoped assistants for recurring text work, with human approval when you
        ask for it.
      </PageTitle>
      <Feedback action={action} />
      {initialDraft && (
        <div className="notice">
          <ShieldCheck size={18} />
          Choose an active Clerk’s transaction draft action. Owners review and
          sign the resulting Safe proposal.
        </div>
      )}
      {outcome && (
        <Panel>
          <div className="section-heading">
            <h2>Latest run</h2>
            <Badge>{outcome.status}</Badge>
          </div>
          {outcome.content && <p className="record-body">{outcome.content}</p>}
          {outcome.error && <p className="error-text">{outcome.error}</p>}
          {outcome.chargedUsd && (
            <p>{money(outcome.chargedUsd, 6)} USDG · Receipt in Ledger</p>
          )}
          {!["complete", "failed"].includes(outcome.status) && (
            <>
              <p className="muted">
                The request is pending or needs reconciliation. Check its
                outcome before starting another.
              </p>
              <Button
                kind="secondary"
                onClick={() =>
                  action.run(async () => {
                    const r = await api.office(
                      office.id,
                      `/requests/${outcome.id}`,
                    );
                    setOutcome(r);
                    if (["complete", "failed"].includes(r.status)) {
                      sessionStorage.removeItem(
                        `chancery:clerk:${account.id}:${office.id}`,
                      );
                      setPrepared(null);
                    }
                  })
                }
              >
                Check request status
              </Button>
            </>
          )}
        </Panel>
      )}
      <div className="clerk-grid">
        {rows.map((c) => (
          <Panel key={c.id}>
            <div className="section-heading">
              <span className="update-symbol">
                <Bot size={24} />
              </span>
              <Badge tone={c.status === "active" ? "green" : ""}>
                {c.status}
              </Badge>
            </div>
            <h2>{c.name}</h2>
            <p className="muted">{c.model}</p>
            <dl className="detail-list">
              <div>
                <dt>30-day allowance</dt>
                <dd>{money(Number(c.monthly_cap_pico) / 1e12)} USDG</dd>
              </div>
              <div>
                <dt>Ask first above</dt>
                <dd>{money(c.rulebook.askAboveUsd, 6)} USDG</dd>
              </div>
              <div>
                <dt>Schedule</dt>
                <dd>
                  {c.schedule_minutes
                    ? `Every ${c.schedule_minutes} minutes`
                    : "Manual runs"}
                </dd>
              </div>
            </dl>
            <div className="actions">
              <Button
                kind="secondary"
                disabled={
                  c.status !== "active" ||
                  (!!outcome &&
                    !["complete", "failed"].includes(outcome.status)) ||
                  action.busy
                }
                onClick={() => action.run(() => prepare(c.id))}
              >
                <Play size={15} />
                Prepare run
              </Button>
              {c.status === "active" && (
                <Button
                  kind="ghost"
                  disabled={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      await api.office(office.id, `/clerks/${c.id}/pause`, {});
                      await load();
                    })
                  }
                >
                  <Pause size={15} />
                  Pause
                </Button>
              )}
              {principal && c.status === "paused" && (
                <Button
                  kind="ghost"
                  onClick={() =>
                    action.run(async () => {
                      await api.office(office.id, `/clerks/${c.id}/resume`, {});
                      await load();
                    })
                  }
                >
                  Resume
                </Button>
              )}
              {principal && (
                <Button
                  kind="ghost"
                  onClick={() =>
                    action.run(async () => {
                      await api.office(office.id, `/clerks/${c.id}/revoke`, {});
                      await onProposal();
                    })
                  }
                >
                  Revoke allowance
                </Button>
              )}
              {drafts && c.status === "active" && (
                <Button kind="ghost" onClick={() => setDraft(c)}>
                  <ShieldCheck size={15} />
                  Transaction draft
                </Button>
              )}
            </div>
            <JsonDetails label="Rulebook" value={c.rulebook} />
          </Panel>
        ))}
      </div>
      {!rows.length && (
        <Empty title="Your next pair of hands." icon={<Bot />}>
          Create a Clerk with a specific text task. A Safe owner approves its
          allowance before it can run.
        </Empty>
      )}
      <div className="section-heading">
        <h2>Clerk approval queue</h2>
        <Badge>
          {approvals.filter((a) => a.status === "pending").length} pending
        </Badge>
      </div>
      {approvals
        .filter(
          (a) =>
            !a.consumed_at && new Date(a.expires_at).getTime() > Date.now(),
        )
        .map((a) => (
          <Panel key={a.id}>
            <div className="section-heading">
              <h3>
                {rows.find((c) => c.id === a.clerk_id)?.name || "Clerk request"}
              </h3>
              <Badge>{a.status}</Badge>
            </div>
            <p className="muted">
              Maximum {money(Number(a.max_cost_pico) / 1e12, 6)} USDG · Expires{" "}
              {date(a.expires_at)}
            </p>
            <JsonDetails label="Review exact request" value={a.chat} />
            <div className="actions">
              {a.status === "pending" && (
                <>
                  <Button
                    kind="secondary"
                    disabled={action.busy}
                    onClick={() =>
                      action.run(async () => {
                        await api.office(office.id, `/approvals/${a.id}`, {
                          approve: true,
                        });
                        await load();
                      })
                    }
                  >
                    Approve request
                  </Button>
                  <Button
                    kind="ghost"
                    disabled={action.busy}
                    onClick={() =>
                      action.run(async () => {
                        await api.office(office.id, `/approvals/${a.id}`, {
                          approve: false,
                        });
                        await load();
                      })
                    }
                  >
                    Deny
                  </Button>
                </>
              )}
              {a.status === "approved" && (
                <Button
                  kind="secondary"
                  disabled={
                    action.busy ||
                    (!!outcome &&
                      !["complete", "failed"].includes(outcome.status))
                  }
                  onClick={() =>
                    action.run(async () => {
                      await prepare(a.clerk_id, a.chat);
                      setPrepared((p: any) => ({
                        ...p,
                        approved: true,
                        approvalId: a.id,
                      }));
                    })
                  }
                >
                  Quote approved run
                </Button>
              )}
            </div>
          </Panel>
        ))}
      {creating && (
        <Modal title="Give your Clerk a job." close={() => setCreating(false)}>
          <form
            onSubmit={submit(() =>
              action.run(async () => {
                const guard = checkGuards(job);
                if (guard) throw new Error(guard.message);
                const limit = Math.min(
                  1024,
                  models.find((m) => m.id === model)?.maxTokens || 1024,
                );
                await api.office(office.id, "/clerks", {
                  name,
                  job,
                  model,
                  monthlyCap: cap,
                  rulebook: {
                    models: [model],
                    perRequestUsd: perRequest,
                    perHourUsd: hour,
                    perDayUsd: day,
                    perWeekUsd: week,
                    askAboveUsd: ask,
                    maxTokens: limit,
                  },
                  ...(schedule ? { scheduleMinutes: Number(schedule) } : {}),
                });
                setCreating(false);
                await onProposal();
              }),
            )}
          >
            <Field label="Name">
              <input
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Research Clerk"
              />
            </Field>
            <Field
              label="Job instructions"
              help="Text-only work. Include the context the Clerk needs; it does not browse sources or execute tools."
            >
              <textarea
                required
                maxLength={20000}
                rows={4}
                value={job}
                onChange={(e) => setJob(e.target.value)}
              />
            </Field>
            <Field label="AI model">
              <select
                required
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="form-grid">
              {[
                ["30-day cap", cap, setCap],
                ["Per-request cap", perRequest, setPerRequest],
                ["Hourly cap", hour, setHour],
                ["Daily cap", day, setDay],
                ["Weekly cap", week, setWeek],
                ["Ask first above", ask, setAsk],
              ].map(([label, v, set]) => (
                <Field key={label as string} label={`${label} · USDG`}>
                  <input
                    type="number"
                    min={label === "Ask first above" ? "0" : "0.000001"}
                    max="5000"
                    step="0.000001"
                    required
                    value={v as string}
                    onChange={(e) =>
                      (set as (v: string) => void)(e.target.value)
                    }
                  />
                </Field>
              ))}
            </div>
            <Field
              label="Run every … minutes"
              help="Leave empty for manual runs. Scheduled work may spend automatically within its approved rules."
            >
              <input
                type="number"
                min="5"
                max="43200"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
              />
            </Field>
            <Feedback action={action} />
            <Button type="submit" busy={action.busy} disabled={!model}>
              Prepare Clerk allowance
            </Button>
          </form>
        </Modal>
      )}
      {prepared && (
        <Modal
          title="Review the Clerk’s request"
          close={() => setPrepared(null)}
        >
          <p>
            Maximum charge:{" "}
            <strong>{money(prepared.quote.maximumUsd, 6)} USDG</strong>
          </p>
          <p className="muted">
            Quote expires {date(prepared.quote.expiresAt)}.
          </p>
          <JsonDetails label="Exact request" value={prepared.chat} />
          <Feedback action={action} />
          <div className="actions">
            {!prepared.approved && (
              <Button
                kind="secondary"
                busy={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await api.office(
                      office.id,
                      `/approvals/${prepared.approvalId}`,
                      { approve: true },
                    );
                    setPrepared({ ...prepared, approved: true });
                    await load();
                  })
                }
              >
                Approve exact request
              </Button>
            )}
            <Button
              busy={action.busy}
              disabled={
                !prepared.approved ||
                prepared.sent ||
                Date.now() >= Date.parse(prepared.quote.expiresAt)
              }
              onClick={() =>
                action.run(async () => {
                  sessionStorage.setItem(
                    `chancery:clerk:${account.id}:${office.id}`,
                    prepared.requestId,
                  );
                  await run();
                })
              }
            >
              Run at quoted maximum
            </Button>
          </div>
        </Modal>
      )}
      {draft && (
        <Modal
          title="Prepare a Safe transaction draft"
          close={() => setDraft(null)}
        >
          <form
            onSubmit={submit(() =>
              action.run(async () => {
                await api.office(office.id, `/clerks/${draft.id}/safe-drafts`, {
                  to,
                  data,
                  value,
                  explanation,
                });
                setDraft(null);
                if (principal) await onProposal();
                else
                  action.setNotice(
                    "Draft prepared. Ask a Safe owner to review it in Approvals.",
                  );
              }),
            )}
          >
            <Field label="Target address">
              <input
                required
                pattern="0x[0-9a-fA-F]{40}"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
            <Field label="Calldata">
              <textarea
                required
                value={data}
                onChange={(e) => setData(e.target.value)}
                rows={3}
              />
            </Field>
            <Field label="Native value · wei">
              <input
                pattern="[0-9]+"
                required
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
            <Field label="Explanation">
              <textarea
                required
                value={explanation}
                onChange={(e) => setExplanation(e.target.value)}
                rows={3}
              />
            </Field>
            <div className="notice warning">
              Simulation checks whether the call succeeds at the current state.
              It does not show a state diff or guarantee future execution. Safe
              owners must review and sign.
            </div>
            <Feedback action={action} />
            <Button busy={action.busy} type="submit">
              Simulate & prepare draft
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
