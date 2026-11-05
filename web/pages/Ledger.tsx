import { useEffect, useMemo, useState } from "react";
import {
  CircleCheck,
  Copy,
  Download,
  ExternalLink,
  ReceiptText,
  RefreshCw,
  X,
} from "lucide-react";
import { useOffice } from "../App";
import {
  api,
  date,
  money,
  short,
  download,
  exportLedger,
  type Receipt,
} from "../api";
import { Button, Empty, Feedback, JsonDetails, useAction } from "../ui";
import {
  Amount,
  Monogram,
  Pill,
  SidePanel,
  SideItem,
  SideSection,
  Stat,
} from "../shell";
import {
  charged,
  isSeatFee,
  modelLabel,
  monthLabel,
  payload,
  receiptState,
  recentMonths,
  sum,
  thisMonth,
  tokens,
  shortId,
} from "../data";
import { RHC } from "../../shared/chain";

const views = [
  { id: "all", label: "All spending", test: (_: Receipt) => true },
  { id: "usage", label: "AI requests", test: (r: Receipt) => !isSeatFee(r) },
  { id: "seats", label: "Seat fees", test: (r: Receipt) => isSeatFee(r) },
  { id: "clerks", label: "Clerks", test: (r: Receipt) => payload(r).actorKind === "clerk" },
  { id: "unsettled", label: "Awaiting settlement", test: (r: Receipt) => !r.settlement_id },
  { id: "provisional", label: "Provisional", test: (r: Receipt) => payload(r).status === "pending" },
] as const;

export function Ledger() {
  const { office, models } = useOffice(),
    action = useAction(),
    drawer = useAction(),
    [month, setMonth] = useState(thisMonth()),
    [rows, setRows] = useState<Receipt[] | null>(null),
    [view, setView] = useState<(typeof views)[number]["id"]>("all"),
    [actor, setActor] = useState(""),
    [model, setModel] = useState(""),
    [selected, setSelected] = useState<Receipt | null>(null),
    [proof, setProof] = useState<any>(null),
    [verification, setVerification] = useState<any>(null),
    [seats, setSeats] = useState<any[]>([]);
  const manager = ["principal", "officer"].includes(office.role);
  const load = async () =>
    setRows(await api.office(office.id, `/ledger?month=${month}`));
  useEffect(() => {
    if (office.status === "active" && office.role !== "guest") void action.run(load);
  }, [office.id, month, office.status]);
  useEffect(() => {
    if (manager) void api.office(office.id, "/seats").then(setSeats).catch(() => {});
  }, [office.id]);
  const names = useMemo(() => new Map(models.map((m) => [m.id, m.name])), [models]);
  const actorName = (id: string, kind?: string) => {
    if (kind === "clerk") return "Clerk";
    const seat = seats.find((s) => s.id === id);
    if (seat)
      return seat.credential?.startsWith("wallet:")
        ? short(seat.credential.slice(7))
        : "Passkey member";
    return id ? short(id) : "—";
  };
  if (office.role === "guest")
    return (
      <>
        <SidePanel title="Ledger" />
        <Empty title="A little privacy for your team." icon={<ReceiptText />}>
          Your guest access covers your invited Rooms. The Ledger is available
          to Office members.
        </Empty>
      </>
    );
  const all = rows || [];
  const viewTest = views.find((v) => v.id === view)!.test;
  const filtered = all.filter(
    (r) =>
      viewTest(r) &&
      (!actor || payload(r).actorId === actor) &&
      (!model || modelLabel(r, names) === model),
  );
  const actors = [...new Set(all.map((r) => payload(r).actorId).filter(Boolean))];
  const kinds = new Map(all.map((r) => [payload(r).actorId, payload(r).actorKind]));
  const modelNames = [...new Set(all.map((r) => modelLabel(r, names)))];
  const unsettled = all.filter((r) => !r.settlement_id);
  async function openReceipt(r: Receipt) {
    setSelected(r);
    setProof(null);
    setVerification(null);
    await drawer.run(async () => setProof(await api.office(office.id, `/ledger/${r.id}/proof`)));
  }
  async function verify() {
    const anchor = proof.anchor || proof.settlement;
    setVerification(
      await api.request("/verify", {
        envelope: proof.envelope,
        ...(anchor ? { leaf: proof.leaf, root: anchor.root, proof: anchor.proof } : {}),
      }),
    );
  }
  const p = selected ? payload(selected) : null;
  const t = selected ? tokens(selected) : null;
  const explorer = RHC.blockExplorers.default.url;
  return (
    <>
      <SidePanel title="Ledger">
        <SideSection label="Views">
          {views.map((v) => (
            <SideItem
              key={v.id}
              active={view === v.id}
              title={v.label}
              trailing={rows ? <span className="count">{all.filter(v.test).length}</span> : undefined}
              onClick={() => setView(v.id)}
            />
          ))}
        </SideSection>
        <SideSection label="Statements">
          {recentMonths(6).map((m) => (
            <SideItem
              key={m}
              active={month === m}
              title={monthLabel(m)}
              trailing={m === thisMonth() ? <Pill>Open</Pill> : <Pill tone="green">Closed</Pill>}
              onClick={() => setMonth(m)}
            />
          ))}
        </SideSection>
      </SidePanel>
      <header className="page-head">
        <div>
          <h1>{views.find((v) => v.id === view)!.label}</h1>
          <p>
            {monthLabel(month)} · signed receipts for{" "}
            {office.role === "member" ? "your" : "your Office’s"} AI usage and seat fees
          </p>
        </div>
      </header>
      <div className="toolbar">
        <label className="select">
          <span>Month</span>
          <input
            type="month"
            value={month}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
          />
        </label>
        {manager && (
          <label className="select">
            <span>Member</span>
            <select value={actor} onChange={(e) => setActor(e.target.value)}>
              <option value="">Everyone</option>
              {actors.map((a) => (
                <option key={a} value={a}>
                  {actorName(a, kinds.get(a))}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="select">
          <span>Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">All models</option>
            {modelNames.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <span className="toolbar-gap" />
        <Button kind="ghost" busy={action.busy} onClick={() => action.run(load)} aria-label="Refresh ledger">
          <RefreshCw size={14} />
        </Button>
        <Button kind="secondary" disabled={!all.length} onClick={() => action.run(() => exportLedger(office.id, month, "csv"))}>
          <Download size={14} /> CSV
        </Button>
        <Button kind="secondary" disabled={!all.length} onClick={() => action.run(() => exportLedger(office.id, month, "json"))}>
          JSON
        </Button>
      </div>
      <Feedback action={action} />
      <div className="summary">
        <Stat label="Spent this month" value={rows ? money(sum(all)) : "—"} unit="USDG" />
        <Stat label="AI requests" value={rows ? all.filter((r) => !isSeatFee(r)).length.toLocaleString() : "—"} />
        <Stat label="Settled" value={rows ? money(sum(all.filter((r) => r.settlement_id))) : "—"} unit="USDG" />
        <Stat label="Awaiting settlement" value={rows ? money(sum(unsettled)) : "—"} unit="USDG" />
      </div>
      <div className={`ledger-body ${selected ? "with-drawer" : ""}`}>
        <div className="table-card">
          {filtered.length ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    {manager && <th>Member</th>}
                    <th>Model</th>
                    <th className="num">Tokens in / out</th>
                    <th className="num">Cost (USDG)</th>
                    <th>Receipt</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const state = receiptState(r),
                      tk = tokens(r);
                    return (
                      <tr
                        key={r.id}
                        className={`clickable ${selected?.id === r.id ? "selected" : ""}`}
                        onClick={() => openReceipt(r)}
                        tabIndex={0}
                        onKeyDown={(e) => e.key === "Enter" && openReceipt(r)}
                      >
                        <td className="nowrap">{date(r.created_at)}</td>
                        {manager && (
                          <td className="who">
                            <Monogram value={actorName(payload(r).actorId, payload(r).actorKind) || "?"} />
                            {actorName(payload(r).actorId, payload(r).actorKind)}
                          </td>
                        )}
                        <td>{modelLabel(r, names)}</td>
                        <td className="num muted">
                          {tk ? `${tk.input.toLocaleString()} / ${tk.output.toLocaleString()}` : "—"}
                        </td>
                        <td className="num">
                          <Amount value={charged(r)} places={charged(r) && charged(r) < 0.01 ? 6 : 2} />
                        </td>
                        <td>
                          <code>{shortId(r.id)}</code>
                        </td>
                        <td>
                          <Pill tone={state.tone}>{state.label}</Pill>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon={<ReceiptText />} title={rows ? "Nothing in this view." : "Loading your statement…"}>
              Receipts appear after paid AI requests or seat fees. Pick another
              month or view to look back.
            </Empty>
          )}
          <div className="table-foot">
            <span className="muted">
              {filtered.length.toLocaleString()} of {all.length.toLocaleString()} receipts
              {all.length === 5000 ? " · export for the full statement" : ""}
            </span>
            <span className="muted">Receipts are signed and independently verifiable.</span>
          </div>
        </div>
        {selected && p && (
          <aside className="drawer" aria-label="Receipt">
            <header>
              <nav className="crumbs">
                <span>Ledger</span>
                <span>/</span>
                <strong>Receipt</strong>
              </nav>
              <button className="icon-button" aria-label="Close receipt" onClick={() => setSelected(null)}>
                <X size={16} />
              </button>
            </header>
            <h2 className="mono-title">Receipt {shortId(selected.id)}</h2>
            <div className="drawer-amount">
              <strong>
                {money(p.chargedUsd, 6)} <span>USDG</span>
              </strong>
              <Pill tone={receiptState(selected).tone}>{receiptState(selected).label}</Pill>
            </div>
            <ol className="timeline">
              {p.maximumUsd && (
                <li className="done">
                  <strong>Quoted ≤ {money(p.maximumUsd, 6)} USDG</strong>
                  <small>Maximum approved before sending</small>
                </li>
              )}
              <li className={p.status === "final" ? "done" : "wait"}>
                <strong>{isSeatFee(selected) ? "Seat fee recorded" : p.status === "final" ? "Completed" : "Provisional"}</strong>
                <small>{date(p.issuedAt || selected.created_at)}</small>
              </li>
              <li className={proof?.anchor ? "done" : "wait"}>
                <strong>{proof?.anchor ? "Anchored onchain" : "Anchor pending"}</strong>
                {proof?.anchor?.transactionHash && (
                  <a href={`${explorer}/tx/${proof.anchor.transactionHash}`} target="_blank" rel="noreferrer">
                    {short(proof.anchor.transactionHash)} <ExternalLink size={12} />
                  </a>
                )}
              </li>
              <li className={selected.settlement_id ? "done" : "wait"}>
                <strong>{selected.settlement_id ? "Settled" : "Awaiting settlement"}</strong>
                {proof?.settlement?.transactionHash && (
                  <a href={`${explorer}/tx/${proof.settlement.transactionHash}`} target="_blank" rel="noreferrer">
                    {short(proof.settlement.transactionHash)} <ExternalLink size={12} />
                  </a>
                )}
              </li>
            </ol>
            <dl className="kv">
              <div>
                <dt>Model</dt>
                <dd>{modelLabel(selected, names)}</dd>
              </div>
              {manager && (
                <div>
                  <dt>Member</dt>
                  <dd>{actorName(p.actorId, p.actorKind)}</dd>
                </div>
              )}
              {p.lane && (
                <div>
                  <dt>Privacy lane</dt>
                  <dd>{p.lane === "zero_retention" ? "Zero retention" : "Standard"}</dd>
                </div>
              )}
              {t && (
                <div>
                  <dt>Tokens in / out</dt>
                  <dd>
                    {t.input.toLocaleString()} / {t.output.toLocaleString()}
                  </dd>
                </div>
              )}
              {p.providerUsd != null && (
                <div>
                  <dt>Provider cost</dt>
                  <dd>{money(p.providerUsd, 6)} USDG</dd>
                </div>
              )}
              {p.platformFeeUsd != null && (
                <div>
                  <dt>Platform fee</dt>
                  <dd>{money(p.platformFeeUsd, 6)} USDG</dd>
                </div>
              )}
            </dl>
            <section className="verify-card">
              <h3>Verification</h3>
              <Feedback action={drawer} />
              {verification ? (
                <ul>
                  <li className={verification.valid ? "ok" : "bad"}>
                    <CircleCheck size={15} /> Signature {verification.valid ? "valid" : "invalid"}
                  </li>
                  {verification.proofValid !== null && (
                    <li className={verification.proofValid ? "ok" : "bad"}>
                      <CircleCheck size={15} /> Merkle proof {verification.proofValid ? "matches" : "does not match"}
                    </li>
                  )}
                  <li className="muted">Check the linked transaction for onchain confirmation.</li>
                </ul>
              ) : (
                <p className="muted">Check the server signature and, once anchored, the Merkle proof.</p>
              )}
              <Button kind="secondary" disabled={!proof} busy={drawer.busy} onClick={() => drawer.run(verify)}>
                Verify receipt
              </Button>
            </section>
            {proof && <JsonDetails value={proof} label="Full receipt and proof" />}
            <footer>
              <Button disabled={!proof} onClick={() => download(`chancery-${selected.id}.json`, proof)}>
                <Download size={14} /> Download JSON
              </Button>
              <Button
                kind="secondary"
                disabled={!proof}
                onClick={() =>
                  drawer.run(async () => {
                    await navigator.clipboard.writeText(JSON.stringify(proof));
                    drawer.setNotice("Proof copied.");
                  })
                }
              >
                <Copy size={14} /> Copy proof
              </Button>
            </footer>
          </aside>
        )}
      </div>
    </>
  );
}
