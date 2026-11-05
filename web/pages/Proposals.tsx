import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Copy,
  FileCheck2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useOffice } from "../App";
import { api, date, short } from "../api";
import { signSafe, sendSafe } from "../wallet";
import {
  Button,
  Empty,
  Feedback,
  Field,
  JsonDetails,
  Panel,
  useAction,
} from "../ui";
import { sentence } from "../data";
import { Dots, Monogram, Pill, SidePanel, SideItem, SideSection } from "../shell";
const titles: Record<string, string> = {
  open: "Open Office & set allowance",
  seats: "Update Office seats",
  policy: "Update Office rules",
  cap: "Change Office budget",
  close: "Close Office permanently",
  clerk: "Authorize a Clerk",
  safe_draft: "Review transaction draft",
  revoke: "Revoke a Clerk",
};
export function Proposals() {
  const { office, account, provider, refresh, reloadApprovals } = useOffice(),
    action = useAction(),
    [rows, setRows] = useState<any[]>([]),
    [detail, setDetail] = useState<any>(null),
    [execution, setExecution] = useState<any>(null),
    [txHash, setTxHash] = useState(""),
    [ack, setAck] = useState(false);
  const key = (id: string) =>
    `chancery:execution:${account.id}:${office.id}:${id}`;
  async function load() {
    setRows(await api.office(office.id, "/proposals"));
  }
  useEffect(() => {
    if (office.role === "principal") void action.run(load);
  }, [office.id, office.status]);
  async function open(id: string) {
    const p = await api.office(office.id, `/proposals/${id}`);
    setDetail(p);
    setAck(false);
    setExecution(null);
    setTxHash(sessionStorage.getItem(key(id)) || p.tx_hash || "");
    if (p.status === "pending")
      try {
        setExecution(await api.office(office.id, `/proposals/${id}/execution`));
      } catch (error) {
        throw error;
      }
  }
  async function sign() {
    await signSafe(
      provider,
      account.wallet,
      office.safe,
      detail.safe_tx,
      detail.safe_tx_hash,
    ).then((signature) =>
      api.office(office.id, `/proposals/${detail.id}/signatures`, {
        signature,
      }),
    );
    setExecution(
      await api.office(office.id, `/proposals/${detail.id}/execution`),
    );
    action.setNotice(
      "Your signature is saved. Execute after the required owners have signed.",
    );
  }
  async function execute() {
    const ready = await api.office(
      office.id,
      `/proposals/${detail.id}/execution`,
    );
    setExecution(ready);
    if (!ready.ready)
      throw new Error("More Safe owner signatures are required.");
    if (ready.safeTxHash !== detail.safe_tx_hash)
      throw new Error(
        "The proposal changed. Review it again before submitting.",
      );
    const hash = await sendSafe(
      provider,
      account.wallet,
      office.safe,
      ready.execution,
      detail.safe_tx,
      ready.signatures,
    );
    setTxHash(hash);
    sessionStorage.setItem(key(detail.id), hash);
    action.setNotice(
      "Transaction submitted. After confirmation, use Check confirmation to activate the change.",
    );
  }
  async function confirm() {
    await api.office(office.id, `/proposals/${detail.id}/confirm`, {
      transactionHash: txHash,
    });
    sessionStorage.removeItem(key(detail.id));
    setDetail(null);
    await refresh();
    await load();
    await reloadApprovals();
    action.setNotice(
      "The Safe change is confirmed and your Office is up to date.",
    );
  }
  const [tab, setTab] = useState<"queue" | "history">("queue");
  useEffect(() => {
    if (detail || !rows.length) return;
    const first = rows.find((r) => r.status === "pending") || rows[0];
    if (first) void action.run(() => open(first.id));
  }, [rows.length]);
  if (office.role !== "principal")
    return (
      <>
        <SidePanel title="Approvals" />
        <Empty title="Your Safe owners handle these." icon={<ShieldCheck />}>
          Treasury changes require the Safe’s owner signatures. Officers can
          review Clerk requests in Clerks.
        </Empty>
      </>
    );
  const queue = rows.filter((r) => r.status === "pending"),
    history = rows.filter((r) => r.status !== "pending"),
    visible = tab === "queue" ? queue : history;
  const signed = new Set(
    (execution?.signatures || []).map((s: any) => s.owner.toLowerCase()),
  );
  const mine = account.wallet?.toLowerCase();
  const needed = execution?.threshold ?? office.threshold;
  const have = execution?.signatures.length ?? 0;
  const params = Object.entries(detail?.payload || {}).filter(
    ([k, v]) => k !== "calls" && v !== null && v !== undefined && v !== "",
  );
  return (
    <>
      <SidePanel title="Approvals">
        <div className="segmented" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "queue"}
            className={tab === "queue" ? "active" : ""}
            onClick={() => setTab("queue")}
          >
            Queue <span className="count">{queue.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === "history"}
            className={tab === "history" ? "active" : ""}
            onClick={() => setTab("history")}
          >
            History
          </button>
        </div>
        <SideSection>
          {visible.length ? (
            visible.map((p) => (
              <SideItem
                key={p.id}
                active={detail?.id === p.id}
                leading={<span className="nonce">#{p.nonce}</span>}
                title={titles[p.kind] || p.kind}
                meta={date(p.created_at)}
                trailing={
                  p.status === "pending" ? (
                    <Pill tone="amber">Pending</Pill>
                  ) : (
                    <Pill tone={p.status === "confirmed" ? "green" : ""}>
                      {sentence(p.status)}
                    </Pill>
                  )
                }
                onClick={() => action.run(() => open(p.id))}
              />
            ))
          ) : (
            <p className="side-note">
              {tab === "queue"
                ? "Nothing waiting for signatures."
                : "Confirmed and replaced proposals appear here."}
            </p>
          )}
        </SideSection>
        {office.status === "pending" &&
          !rows.some((r) => r.kind === "open" && r.status === "pending") && (
            <button
              className="side-new"
              onClick={() =>
                action.run(async () => {
                  await api.office(office.id, "/open/propose", {});
                  await load();
                })
              }
            >
              Prepare opening approval
            </button>
          )}
      </SidePanel>
      <Feedback action={action} />
      {!detail ? (
        <Empty title="All clear." icon={<FileCheck2 />}>
          New Safe approvals appear here when you open an Office or propose a
          change.
        </Empty>
      ) : (
        <div className="detail-page">
          <nav className="crumbs">
            <span>Approvals</span>
            <span>/</span>
            <strong>#{detail.nonce ?? short(detail.id)}</strong>
          </nav>
          <header className="detail-head">
            <div>
              <h1>{titles[detail.kind] || "Safe proposal"}</h1>
              <p>
                Created {date(detail.created_at)} · Safe nonce {detail.nonce}
              </p>
            </div>
            <div className="quorum">
              <span>
                {have} of {needed}
              </span>
              <Dots have={have} need={needed} />
              <Pill
                tone={
                  detail.status === "confirmed"
                    ? "green"
                    : execution?.ready
                      ? "green"
                      : "amber"
                }
              >
                {detail.status === "pending"
                  ? execution?.ready
                    ? "Ready to execute"
                    : "Awaiting signatures"
                  : sentence(detail.status)}
              </Pill>
            </div>
          </header>
          {detail.kind === "close" && (
            <div className="notice error">
              Closing is permanent. It stops all delegates, including
              outstanding settlements.
            </div>
          )}
          {detail.kind === "open" && (
            <div className="notice warning">
              This authorizes recurring USDG collection within the Office’s
              30-day cap. Your Safe keeps custody until settlement. Owners can
              revoke the allowance.
            </div>
          )}
          <Panel className="card">
            <div className="card-head">
              <h2>Proposed change</h2>
            </div>
            <dl className="kv">
              <div>
                <dt>Action</dt>
                <dd>{titles[detail.kind] || detail.kind}</dd>
              </div>
              {params.map(([k, v]) => (
                <div key={k}>
                  <dt>{humanize(k)}</dt>
                  <dd>
                    <Value value={v} />
                  </dd>
                </div>
              ))}
              <div>
                <dt>Safe</dt>
                <dd>
                  <code>{office.safe}</code>
                </dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>Robinhood Chain · 4663</dd>
              </div>
            </dl>
          </Panel>
          <Panel className="card hash-card">
            <span>Safe transaction hash to sign</span>
            <code>{detail.safe_tx_hash}</code>
            <button
              className="icon-button"
              aria-label="Copy hash"
              onClick={() =>
                action.run(async () => {
                  await navigator.clipboard.writeText(detail.safe_tx_hash);
                  action.setNotice("Hash copied.");
                })
              }
            >
              <Copy size={14} />
            </button>
          </Panel>
          <Panel className="card">
            <div className="card-head">
              <h2>Signers</h2>
              <span className="muted">
                {needed} of {office.owners.length} owners required
              </span>
            </div>
            <table className="table">
              <tbody>
                {office.owners.map((o) => {
                  const done = signed.has(o.toLowerCase());
                  return (
                    <tr key={o}>
                      <td className="who">
                        <Monogram value={o} />
                        <code>{short(o)}</code>
                        {o.toLowerCase() === mine && <Pill tone="ink">You</Pill>}
                      </td>
                      <td className="end">
                        <Pill tone={done ? "green" : "amber"}>
                          {done ? "Signed" : "Awaiting"}
                        </Pill>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
          <JsonDetails
            label="Exact calls and Safe transaction"
            value={{ kind: detail.kind, payload: detail.payload, safeTx: detail.safe_tx }}
          />
          {detail.status === "pending" && (
            <>
              <details className="recovery">
                <summary>Already executed, or Safe nonce changed?</summary>
                <Field label="Execution transaction hash">
                  <input
                    value={txHash}
                    onChange={(e) => setTxHash(e.target.value.trim())}
                    placeholder="0x…"
                  />
                </Field>
                <div className="actions">
                  <Button
                    kind="secondary"
                    disabled={!/^0x[0-9a-fA-F]{64}$/.test(txHash)}
                    busy={action.busy}
                    onClick={() => action.run(confirm)}
                  >
                    Check confirmation
                  </Button>
                  <Button
                    kind="ghost"
                    disabled={!!txHash}
                    busy={action.busy}
                    onClick={() =>
                      action.run(async () => {
                        const p = await api.office(
                          office.id,
                          `/proposals/${detail.id}/refresh`,
                          {},
                        );
                        await load();
                        await open(p.id);
                      })
                    }
                  >
                    Prepare fresh proposal
                  </Button>
                </div>
                <p className="muted">
                  Confirmation requires a successful Safe execution plus one
                  block. If another transaction changed the Safe nonce, prepare
                  a fresh proposal and collect new signatures.
                </p>
              </details>
              <div className="action-bar">
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                  />
                  I have reviewed the proposed calls and amounts.
                </label>
                <span className="muted">
                  {txHash
                    ? `Submitted ${short(txHash)}`
                    : execution?.ready
                      ? "Threshold met · ready to execute"
                      : `${Math.max(0, needed - have)} more signature${needed - have === 1 ? "" : "s"} required`}
                </span>
                <Button
                  kind="ghost"
                  disabled={action.busy}
                  onClick={() => action.run(() => open(detail.id))}
                >
                  <RefreshCw size={14} />
                </Button>
                {txHash ? (
                  <Button busy={action.busy} onClick={() => action.run(confirm)}>
                    Check confirmation
                  </Button>
                ) : execution?.ready ? (
                  <Button
                    disabled={!ack}
                    busy={action.busy}
                    onClick={() => action.run(execute)}
                  >
                    Execute in wallet
                    <ArrowUpRight size={14} />
                  </Button>
                ) : (
                  <Button
                    disabled={
                      !ack ||
                      !execution ||
                      (!!mine && signed.has(mine))
                    }
                    busy={action.busy}
                    onClick={() => action.run(sign)}
                  >
                    {mine && signed.has(mine) ? "Signed" : "Sign with wallet"}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
function humanize(key: string) {
  const text = key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\busd\b/i, "(USDG)");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function Value({ value }: { value: unknown }) {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value))
    return <code>{value}</code>;
  if (typeof value === "string" || typeof value === "number")
    return <>{String(value)}</>;
  if (typeof value === "boolean") return <>{value ? "Yes" : "No"}</>;
  if (Array.isArray(value) && value.every((v) => typeof v !== "object"))
    return <>{value.length ? value.join(", ") : "None"}</>;
  return <code className="json-inline">{JSON.stringify(value)}</code>;
}
