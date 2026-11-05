import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  Layers,
  MessageSquare,
  ReceiptText,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { useOffice } from "../App";
import { api, money, short, type Receipt, type Conversation } from "../api";
import { Empty, Feedback, Panel, useAction } from "../ui";
import {
  Amount,
  Count,
  Pill,
  SidePanel,
  SideItem,
  SideSection,
  SpendChart,
  Stat,
} from "../shell";
import {
  charged,
  cumulativeByDay,
  dayGroup,
  greeting,
  groupBy,
  isSeatFee,
  modelLabel,
  payload,
  receiptState,
  sum,
  thisMonth,
  time,
} from "../data";

const plural = (n: number, word: string) =>
  `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const seatHint = (n: number) =>
  n ? `Plus ${plural(n, "seat fee")}` : "No seat fees yet";

export function openConversation(id: string) {
  try {
    sessionStorage.setItem("chancery:open-conversation", id);
  } catch {}
}

export function Overview() {
  const { office, navigate, models, pendingApprovals } = useOffice(),
    action = useAction(),
    [receipts, setReceipts] = useState<Receipt[] | null>(null),
    [conversations, setConversations] = useState<Conversation[]>([]);
  const month = thisMonth();
  const member = office.role !== "guest";
  useEffect(() => {
    if (office.status !== "active" || !member) return;
    void action.run(async () => {
      const [r, c] = await Promise.all([
        api.office(office.id, `/ledger?month=${month}`),
        api.office(office.id, "/conversations"),
      ]);
      setReceipts(r);
      setConversations(c);
    });
  }, [office.id, office.status]);
  const names = useMemo(
    () => new Map(models.map((m) => [m.id, m.name])),
    [models],
  );
  const rows = receipts || [];
  const usage = rows.filter((r) => !isSeatFee(r));
  const unsettled = rows.filter((r) => !r.settlement_id);
  const attention = rows.filter((r) => payload(r).status === "pending");
  const cap = Number(office.capUsd) || 0,
    spent = Number(office.spentUsd) || 0;
  const chart = cumulativeByDay(rows, month);
  const byModel = [...groupBy(rows, (r) => modelLabel(r, names)).entries()]
    .map(([label, list]) => ({ label, value: sum(list) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);
  const top = byModel[0]?.value || 0;
  const needs = [
    pendingApprovals > 0 && {
      id: "approvals",
      icon: <CircleCheck size={16} />,
      title: `${pendingApprovals} approval${pendingApprovals === 1 ? "" : "s"} waiting`,
      go: "proposals",
    },
    office.status !== "active" && {
      id: "office",
      icon: <ShieldCheck size={16} />,
      title: "Office awaiting Safe approval",
      go: "proposals",
    },
    attention.length > 0 && {
      id: "provisional",
      icon: <CircleAlert size={16} />,
      title: `${attention.length} provisional receipt${attention.length === 1 ? "" : "s"}`,
      go: "ledger",
    },
  ].filter(Boolean) as { id: string; icon: ReactElement; title: string; go: string }[];
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  return (
    <>
      <SidePanel title="Home">
        <SideSection label="Needs you">
          {needs.length ? (
            needs.map((n) => (
              <SideItem
                key={n.id}
                leading={n.icon}
                title={n.title}
                trailing={<ArrowRight size={14} />}
                onClick={() => navigate(n.go)}
              />
            ))
          ) : (
            <p className="side-note">
              <CircleCheck size={14} /> Nothing needs you right now.
            </p>
          )}
        </SideSection>
        {member && (
          <SideSection label="Recent chats">
            {conversations.length ? (
              conversations.slice(0, 6).map((c) => (
                <SideItem
                  key={c.id}
                  title={c.title}
                  meta={`${dayGroup(c.createdAt)} · ${time(c.createdAt)}`}
                  onClick={() => {
                    openConversation(c.id);
                    navigate("chat");
                  }}
                />
              ))
            ) : (
              <p className="side-note">Saved conversations appear here.</p>
            )}
          </SideSection>
        )}
      </SidePanel>
      <header className="page-head">
        <div>
          <h1>{greeting()}</h1>
          <p>{today}</p>
        </div>
      </header>
      <Feedback action={action} />
      <div className="stat-row">
        <Stat
          feature
          label="Available"
          value={<Amount value={Math.max(0, cap - spent)} animate />}
          unit="USDG"
          meter={cap > 0 ? (spent / cap) * 100 : 0}
          hint={`of ${money(cap)} · before unsettled usage`}
          onClick={() => navigate("settings")}
          action="Allowance settings"
        />
        <Stat
          label="Spent this cycle"
          value={<Amount value={spent} animate />}
          unit="USDG"
          hint="Settled to your Safe’s allowance"
          onClick={member ? () => navigate("ledger") : undefined}
          action="Open the Ledger"
        />
        <Stat
          label="Requests this month"
          loading={member && !receipts}
          value={receipts ? <Count value={usage.length} /> : "—"}
          hint={receipts ? seatHint(rows.length - usage.length) : undefined}
          onClick={member ? () => navigate("ledger") : undefined}
          action="Open the Ledger"
        />
        <Stat
          label="Awaiting settlement"
          loading={member && !receipts}
          tone={unsettled.length ? "amber" : undefined}
          onClick={member ? () => navigate("ledger") : undefined}
          action="Open the Ledger"
          value={receipts ? <Amount value={sum(unsettled)} animate /> : "—"}
          unit="USDG"
          hint={receipts ? plural(unsettled.length, "receipt") : undefined}
        />
      </div>
      {!member ? (
        <Empty title="Your invitation opens a Room." icon={<ReceiptText />}>
          Guest access covers your invited Rooms. Spending and the Ledger are
          available to Office members.
        </Empty>
      ) : (
        <>
          <Panel className="card chart-card">
            <div className="card-head">
              <div className="card-title">
                <span className="card-icon">
                  <TrendingUp size={16} />
                </span>
                <div>
                  <h2>Spend this month</h2>
                  <p>Cumulative, all receipts you can see · UTC days</p>
                </div>
              </div>
              <div className="card-figure">
                <strong>
                  <Amount value={sum(rows)} /> <small>USDG</small>
                </strong>
                <small>Day {chart.points.length} of {chart.days}</small>
              </div>
            </div>
            {rows.length ? (
              <SpendChart points={chart.points} days={chart.days} month={month} label="Cumulative spend this month" />
            ) : !receipts ? (
              <div className="skeleton chart-skeleton" aria-label="Loading this month’s receipts" />
            ) : (
              <div className="chart-empty">
                <ReceiptText size={18} />
                {receipts ? "No receipts this month yet. Your first request will start the line." : "Loading this month’s receipts…"}
              </div>
            )}
          </Panel>
          <div className="two-col">
            <Panel className="card">
              <div className="card-head">
                <div className="card-title">
                  <span className="card-icon violet">
                    <Layers size={16} />
                  </span>
                  <div>
                    <h2>Spend by model</h2>
                    <p>This month · including seat fees</p>
                  </div>
                </div>
              </div>
              {byModel.length ? (
                <div className="bars">
                  {byModel.map((m, i) => (
                    <div className="bar-row" key={m.label}>
                      <span>{m.label}</span>
                      <span className="bar">
                        <i className={i === 0 ? "lead" : ""} style={{ width: `${top ? (m.value / top) * 100 : 0}%` }} />
                      </span>
                      <span className="num">{money(m.value)}</span>
                    </div>
                  ))}
                  <div className="bar-total">
                    <span>Total</span>
                    <span className="num">{money(sum(rows))} USDG</span>
                  </div>
                </div>
              ) : (
                <p className="card-empty">Model spend appears after your first paid request.</p>
              )}
            </Panel>
            <Panel className="card">
              <div className="card-head">
                <div className="card-title">
                  <span className="card-icon green">
                    <ReceiptText size={16} />
                  </span>
                  <div>
                    <h2>Recent receipts</h2>
                    <p>Signed after every request</p>
                  </div>
                </div>
                <button className="link" onClick={() => navigate("ledger")}>
                  View ledger <ArrowRight size={13} />
                </button>
              </div>
              {rows.length ? (
                <table className="table compact">
                  <tbody>
                    {rows.slice(0, 6).map((r) => {
                      const state = receiptState(r);
                      return (
                        <tr key={r.id}>
                          <td className="muted">{time(r.created_at)}</td>
                          <td>{modelLabel(r, names)}</td>
                          <td className="num">
                            <Amount value={charged(r)} />
                          </td>
                          <td className="end">
                            <Pill tone={state.tone}>{state.label}</Pill>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <p className="card-empty">
                  <Clock3 size={14} /> Paid requests and seat fees will appear here.
                </p>
              )}
            </Panel>
          </div>
          <div className="safe-strip">
            <ShieldCheck size={16} />
            <span>
              Safe <code>{short(office.safe)}</code> ·{" "}
              {office.owners.length === 1
                ? "its sole owner approves changes"
                : `${office.threshold} of ${office.owners.length} owners approve changes`}
            </span>
            <button className="link" onClick={() => navigate("proposals")}>
              Approvals <ArrowRight size={13} />
            </button>
            <button className="link" onClick={() => navigate("chat")}>
              <MessageSquare size={13} /> Workspace
            </button>
          </div>
        </>
      )}
    </>
  );
}
