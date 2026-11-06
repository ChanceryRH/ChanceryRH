import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Bot,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useOffice } from "../App";
import {
  api,
  date,
  money,
  errorText,
  ChanceryError,
  type Receipt,
} from "../api";
import { checkGuards } from "../../shared/guards";
import {
  Button,
  Empty,
  Feedback,
  Field,
  JsonDetails,
  Modal,
  Panel,
  submit,
  useAction,
} from "../ui";
import {
  Amount,
  Pill,
  Progress,
  SidePanel,
  SideItem,
  SideSection,
  Stat,
} from "../shell";
import {
  charged,
  modelLabel,
  monthLabel,
  payload,
  receiptState,
  shortId,
  sum,
  thisMonth,
  tokens,
  sentence,
} from "../data";

const pico = (v: unknown) => Number(v || 0) / 1e12;
export function scheduleText(minutes: number | null | undefined) {
  if (!minutes) return "Manual runs";
  if (minutes % 10080 === 0)
    return minutes === 10080 ? "Weekly" : `Every ${minutes / 10080} weeks`;
  if (minutes % 1440 === 0)
    return minutes === 1440 ? "Daily" : `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0)
    return minutes === 60 ? "Hourly" : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}
function clerkStatus(
  c: any,
  waiting: number,
): {
  label: string;
  tone: "green" | "amber" | "";
} {
  if (c.status === "pending") return { label: "Awaiting Safe", tone: "amber" };
  if (waiting) return { label: "Needs approval", tone: "amber" };
  if (c.status === "active") return { label: "Active", tone: "green" };
  return { label: c.status === "paused" ? "Paused" : c.status, tone: "" };
}
export function Clerks({ initialDraft = false }: { initialDraft?: boolean }) {
  const { office, account, models, config, onProposal, navigate } = useOffice(),
    action = useAction(),
    [rows, setRows] = useState<any[]>([]),
    [approvals, setApprovals] = useState<any[]>([]),
    [creating, setCreating] = useState(false),
    [prepared, setPrepared] = useState<any>(null),
    [outcome, setOutcome] = useState<any>(null),
    [draft, setDraft] = useState<any>(null),
    [receipts, setReceipts] = useState<Receipt[]>([]),
    [selectedId, setSelectedId] = useState("");
  const manager = ["principal", "officer"].includes(office.role),
    principal = office.role === "principal",
    drafts = config.updates.some((u) => u.id === "safe_drafts" && u.enabled),
    month = thisMonth();
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
    const [c, a, r] = await Promise.all([
      api.office(office.id, "/clerks"),
      api.office(office.id, "/approvals"),
      api.office(office.id, `/ledger?month=${month}`).catch(() => []),
    ]);
    setRows(c);
    setApprovals(a);
    setReceipts(r);
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
      approved: p.decision === "allow" || p.approvalStatus === "approved",
    });
    await load();
  }
  async function run() {
    const p = prepared;
    setPrepared({ ...p, sent: true });
    setOutcome({ status: "pending", id: p.requestId, clerkId: p.clerkId });
    try {
      const response = await api.office(office.id, `/clerks/${p.clerkId}/run`, {
        id: p.requestId,
        quoteId: p.quote.id,
        chat: p.chat,
        ...(p.approvalId ? { approvalId: p.approvalId } : {}),
      });
      setOutcome({ ...response, clerkId: p.clerkId });
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
          clerkId: p.clerkId,
          error: errorText(error),
        });
        setPrepared(null);
      } else
        setOutcome({
          status: "unconfirmed",
          id: p.requestId,
          clerkId: p.clerkId,
        });
      throw error;
    }
  }
  useEffect(() => {
    const saved = sessionStorage.getItem(
      `chancery:clerk:${account.id}:${office.id}`,
    );
    if (saved) setOutcome({ status: "unconfirmed", id: saved });
  }, [office.id]);
  const live = approvals.filter(
    (a) => !a.consumed_at && new Date(a.expires_at).getTime() > Date.now(),
  );
  const waitingFor = (id: string) =>
    live.filter((a) => a.clerk_id === id && a.status === "pending").length;
  const clerk = rows.find((c) => c.id === selectedId) || rows[0];
  const names = useMemo(
    () => new Map(models.map((m) => [m.id, m.name])),
    [models],
  );
  const busyRun = !!outcome && !["complete", "failed"].includes(outcome.status);
  if (!manager)
    return (
      <>
        <SidePanel title="Clerks">
          <SideSection>
            <p className="side-note">
              Assistants with a job, a budget and clear approval rules.
            </p>
          </SideSection>
        </SidePanel>
        <Empty title="Your Officers look after the Clerks." icon={<Bot />}>
          Ask an Officer or Safe owner to create a Clerk or review its work.
        </Empty>
      </>
    );
  const runs = clerk
    ? receipts.filter(
        (r) =>
          payload(r).actorKind === "clerk" && payload(r).actorId === clerk.id,
      )
    : [];
  const capUsd = clerk ? pico(clerk.monthly_cap_pico) : 0,
    usedUsd = sum(runs);
  const queue = clerk ? live.filter((a) => a.clerk_id === clerk.id) : [];
  const rule = clerk?.rulebook || {};
  return (
    <>
      <SidePanel
        title="Clerks"
        action={
          <button
            className="icon-button"
            aria-label="Refresh Clerks"
            title="Refresh"
            disabled={action.busy}
            onClick={() => action.run(load)}
          >
            <RefreshCw size={15} />
          </button>
        }
      >
        {principal && (
          <button className="side-new" onClick={() => setCreating(true)}>
            <Plus size={15} />
            New Clerk
          </button>
        )}
        <SideSection>
          {rows.length ? (
            rows.map((c) => {
              const st = clerkStatus(c, waitingFor(c.id));
              return (
                <SideItem
                  key={c.id}
                  active={clerk?.id === c.id}
                  title={c.name}
                  meta={`${scheduleText(c.schedule_minutes)} · ${names.get(c.model) || c.model}`}
                  trailing={<Pill tone={st.tone}>{st.label}</Pill>}
                  onClick={() => setSelectedId(c.id)}
                />
              );
            })
          ) : (
            <p className="side-note">
              {action.busy
                ? "Loading Clerks…"
                : "Your Clerks will appear here."}
            </p>
          )}
        </SideSection>
        {live.some((a) => a.status === "pending") && (
          <SideSection label="Ask-first queue">
            <p className="side-note">
              {live.filter((a) => a.status === "pending").length} run
              {live.filter((a) => a.status === "pending").length === 1
                ? " is"
                : "s are"}{" "}
              waiting for a decision.
            </p>
          </SideSection>
        )}
      </SidePanel>
      <Feedback action={action} />
      {initialDraft && (
        <div className="notice">
          <ShieldCheck size={16} />
          <span>
            Choose an active Clerk’s transaction draft action. Owners review and
            sign the resulting Safe proposal.
          </span>
        </div>
      )}
      {!clerk ? (
        <Empty
          title="Your next pair of hands."
          icon={<Bot />}
          action={
            principal ? (
              <Button onClick={() => setCreating(true)}>
                <Plus size={15} />
                New Clerk
              </Button>
            ) : undefined
          }
        >
          Create a Clerk with a specific text task. A Safe owner approves its
          allowance before it can run.
        </Empty>
      ) : (
        <div className="detail-page">
          <header className="detail-head">
            <div>
              <h1>{clerk.name}</h1>
              <p>
                {names.get(clerk.model) || clerk.model} ·{" "}
                {scheduleText(clerk.schedule_minutes)}
              </p>
            </div>
            <div className="head-actions">
              {(() => {
                const st = clerkStatus(clerk, waitingFor(clerk.id));
                return <Pill tone={st.tone}>{st.label}</Pill>;
              })()}
              {clerk.status === "active" && (
                <Button
                  kind="secondary"
                  disabled={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      await api.office(
                        office.id,
                        `/clerks/${clerk.id}/pause`,
                        {},
                      );
                      await load();
                    })
                  }
                >
                  <Pause size={14} />
                  Pause
                </Button>
              )}
              {principal && clerk.status === "paused" && (
                <Button
                  kind="secondary"
                  disabled={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      await api.office(
                        office.id,
                        `/clerks/${clerk.id}/resume`,
                        {},
                      );
                      await load();
                    })
                  }
                >
                  <Play size={14} />
                  Resume
                </Button>
              )}
              <Button
                disabled={clerk.status !== "active" || busyRun || action.busy}
                onClick={() => action.run(() => prepare(clerk.id))}
              >
                <Play size={14} />
                Prepare run
              </Button>
            </div>
          </header>
          {outcome && (!outcome.clerkId || outcome.clerkId === clerk.id) && (
            <Panel className="card run-outcome">
              <div className="card-head">
                <div>
                  <h2>Latest run</h2>
                  <p>
                    Request <code>{shortId(outcome.id || "")}</code>
                  </p>
                </div>
                <Pill
                  tone={
                    outcome.status === "complete"
                      ? "green"
                      : outcome.status === "failed"
                        ? "red"
                        : "amber"
                  }
                >
                  {sentence(outcome.status)}
                </Pill>
              </div>
              {outcome.content && (
                <p className="record-body">{outcome.content}</p>
              )}
              {outcome.error && <p className="error-text">{outcome.error}</p>}
              {outcome.chargedUsd && (
                <p className="muted">
                  {money(outcome.chargedUsd, 6)} USDG · receipt in the Ledger
                </p>
              )}
              {busyRun && (
                <div className="run-check">
                  <span className="muted">
                    The request is pending or needs reconciliation. Check its
                    outcome before starting another.
                  </span>
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
                </div>
              )}
            </Panel>
          )}
          {clerk.status === "pending" && (
            <div className="notice warning">
              <ShieldCheck size={16} />
              <span>
                This Clerk’s allowance is waiting for Safe approval. It can run
                once the owners execute the proposal.
              </span>
            </div>
          )}
          <Panel className="card clerk-summary">
            <dl className="kv">
              <div>
                <dt>Schedule</dt>
                <dd>{scheduleText(clerk.schedule_minutes)}</dd>
              </div>
              <div>
                <dt>Next run</dt>
                <dd>
                  {!clerk.schedule_minutes
                    ? "When you prepare one"
                    : clerk.status !== "active"
                      ? "Not scheduled while inactive"
                      : clerk.next_run_at
                        ? date(clerk.next_run_at)
                        : "Waiting for the scheduler"}
                </dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{names.get(clerk.model) || clerk.model}</dd>
              </div>
              <div>
                <dt>Approval mode</dt>
                <dd>
                  {Number(rule.askAboveUsd) > 0
                    ? `Ask first above ${money(rule.askAboveUsd, 2)} USDG`
                    : "Ask first on every paid run"}
                </dd>
              </div>
            </dl>
            <div className="clerk-allowance">
              <strong>
                {money(capUsd)} USDG <span>/ 30d</span>
              </strong>
              <small>
                {money(usedUsd)} USDG used in {monthLabel(month)} ·{" "}
                {money(Math.max(0, capUsd - usedUsd))} available
              </small>
              <Progress value={usedUsd} max={capUsd} />
              <small className="muted">
                Allowance set by the Safe · usage from signed receipts
              </small>
            </div>
          </Panel>
          <div className="summary">
            <Stat
              label="Per request"
              value={money(rule.perRequestUsd, 2)}
              unit="USDG"
            />
            <Stat
              label="Per hour"
              value={money(rule.perHourUsd, 2)}
              unit="USDG"
            />
            <Stat
              label="Per day"
              value={money(rule.perDayUsd, 2)}
              unit="USDG"
            />
            <Stat
              label="Per week"
              value={money(rule.perWeekUsd, 2)}
              unit="USDG"
            />
          </div>
          <Panel className="card">
            <div className="card-head">
              <div>
                <h2>
                  Ask-first queue{" "}
                  {queue.some((a) => a.status === "pending") && (
                    <Pill tone="amber">
                      {queue.filter((a) => a.status === "pending").length}{" "}
                      pending
                    </Pill>
                  )}
                </h2>
                <p>
                  Runs above the threshold need approval from a different Safe
                  owner.
                </p>
              </div>
            </div>
            {queue.length ? (
              <div className="queue">
                {queue.map((a) => (
                  <div className="queue-row" key={a.id}>
                    <div className="queue-main">
                      <strong>Run request {shortId(a.id)}</strong>
                      <span className="muted">
                        Quoted ≤ {money(pico(a.max_cost_pico), 6)} USDG ·
                        Expires {date(a.expires_at)}
                      </span>
                    </div>
                    <Pill tone={a.status === "approved" ? "green" : "amber"}>
                      {sentence(a.status)}
                    </Pill>
                    <div className="queue-actions">
                      {a.status === "pending" &&
                        office.role === "principal" &&
                        a.requested_by !== account.id && (
                          <>
                            <Button
                              kind="secondary"
                              disabled={action.busy}
                              onClick={() =>
                                action.run(async () => {
                                  await api.office(
                                    office.id,
                                    `/approvals/${a.id}`,
                                    { approve: false },
                                  );
                                  await load();
                                })
                              }
                            >
                              Decline
                            </Button>
                            <Button
                              disabled={action.busy}
                              onClick={() =>
                                action.run(async () => {
                                  await api.office(
                                    office.id,
                                    `/approvals/${a.id}`,
                                    { approve: true },
                                  );
                                  await load();
                                })
                              }
                            >
                              Approve
                            </Button>
                          </>
                        )}
                      {a.status === "approved" &&
                        a.requested_by === account.id && (
                          <Button
                            disabled={action.busy || busyRun}
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
                    <div className="queue-detail">
                      <JsonDetails
                        label="Review exact request"
                        value={a.chat}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="card-empty">No runs are waiting for approval.</p>
            )}
          </Panel>
          <Panel className="card">
            <div className="card-head">
              <div>
                <h2>Run history</h2>
                <p>{monthLabel(month)} · signed receipts for this Clerk</p>
              </div>
              <button className="link" onClick={() => navigate("ledger")}>
                Open ledger <ArrowRight size={13} />
              </button>
            </div>
            {runs.length ? (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date / time</th>
                      <th>Model</th>
                      <th className="num">Tokens in / out</th>
                      <th className="num">Cost (USDG)</th>
                      <th>Receipt</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.slice(0, 12).map((r) => {
                      const st = receiptState(r),
                        t = tokens(r);
                      return (
                        <tr key={r.id}>
                          <td>{date(r.created_at)}</td>
                          <td>{modelLabel(r, names)}</td>
                          <td className="num muted">
                            {t
                              ? `${t.input.toLocaleString()} / ${t.output.toLocaleString()}`
                              : "—"}
                          </td>
                          <td className="num">
                            <Amount value={charged(r)} />
                          </td>
                          <td>
                            <code>{shortId(r.id)}</code>
                          </td>
                          <td>
                            <Pill tone={st.tone}>{st.label}</Pill>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="table-foot">
                  Showing {Math.min(12, runs.length)} of {runs.length} runs this
                  month
                </p>
              </div>
            ) : (
              <p className="card-empty">
                No runs this month. Prepared runs and scheduled runs appear here
                with their receipts.
              </p>
            )}
          </Panel>
          <div className="safe-strip">
            <ShieldCheck size={16} />
            <span>
              {drafts && clerk.status === "active"
                ? "This Clerk can prepare Safe transaction drafts for owners to review."
                : "Clerks spend only from their own approved allowance."}
            </span>
            {drafts && clerk.status === "active" && (
              <button className="link" onClick={() => setDraft(clerk)}>
                Transaction draft <ArrowRight size={13} />
              </button>
            )}
            {principal && clerk.status !== "pending" && (
              <Button
                kind="secondary"
                busy={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await api.office(office.id, "/allowance/resync", {
                      clerkId: clerk.id,
                    });
                    await onProposal();
                  })
                }
              >
                Prepare allowance recovery
              </Button>
            )}
            {principal && clerk.status !== "pending" && (
              <button
                className="link danger"
                disabled={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await api.office(
                      office.id,
                      `/clerks/${clerk.id}/revoke`,
                      {},
                    );
                    await onProposal();
                  })
                }
              >
                Revoke allowance
              </button>
            )}
          </div>
          <JsonDetails label="Rulebook" value={clerk.rulebook} />
        </div>
      )}
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
              <>
                <p>
                  Another Safe owner must approve this exact request in the
                  Clerk approval queue.
                </p>
                <Button
                  kind="secondary"
                  busy={action.busy}
                  onClick={() =>
                    action.run(() =>
                      prepare(prepared.clerkId || prepared.id, prepared.chat),
                    )
                  }
                >
                  Refresh approval
                </Button>
              </>
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
            <Field label="Your explanation · requester notes">
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
