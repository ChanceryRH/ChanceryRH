import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Check,
  FileCheck2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useOffice } from "../App";
import { api, date, short } from "../api";
import { signSafe, sendSafe } from "../wallet";
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
  useAction,
} from "../ui";
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
  const { office, account, provider, refresh } = useOffice(),
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
    action.setNotice(
      "The Safe change is confirmed and your Office is up to date.",
    );
  }
  if (office.role !== "principal")
    return (
      <Empty title="Your Safe owners handle these." icon={<ShieldCheck />}>
        Treasury changes require the Safe’s owner signatures. Officers can
        review Clerk requests in Updates.
      </Empty>
    );
  return (
    <>
      <PageTitle
        eyebrow="HUMAN AUTHORITY, BUILT IN"
        title="Your signature. Your call."
        actions={
          <Button
            kind="secondary"
            busy={action.busy}
            onClick={() => action.run(load)}
          >
            <RefreshCw size={16} />
            Refresh
          </Button>
        }
      >
        Review each change before signing. Execution is a separate wallet
        transaction.
      </PageTitle>
      <Feedback action={action} />
      {office.status === "pending" &&
        !rows.some((r) => r.kind === "open" && r.status === "pending") && (
          <Button
            onClick={() =>
              action.run(async () => {
                await api.office(office.id, "/open/propose", {});
                await load();
              })
            }
          >
            Prepare opening approval
          </Button>
        )}
      <Panel>
        {rows.length ? (
          <div className="proposal-list">
            {rows.map((p) => (
              <button
                className="proposal-row"
                key={p.id}
                onClick={() => action.run(() => open(p.id))}
              >
                <span className="activity-icon">
                  <ShieldCheck size={21} />
                </span>
                <span>
                  <strong>{titles[p.kind] || p.kind}</strong>
                  <small>
                    {date(p.created_at)} · Safe nonce {p.nonce}
                  </small>
                </span>
                <Badge tone={p.status === "confirmed" ? "green" : ""}>
                  {p.status}
                </Badge>
                <ArrowUpRight size={17} />
              </button>
            ))}
          </div>
        ) : (
          <Empty title="All clear." icon={<FileCheck2 />}>
            New Safe approvals appear here when you open an Office or propose a
            change.
          </Empty>
        )}
      </Panel>
      {detail && (
        <Modal
          title={titles[detail.kind] || "Safe proposal"}
          close={() => setDetail(null)}
        >
          <Badge tone={detail.status === "confirmed" ? "green" : ""}>
            {detail.status}
          </Badge>
          <dl className="detail-list">
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
            <div>
              <dt>Owner signatures</dt>
              <dd>
                {execution
                  ? `${execution.signatures.length} of ${execution.threshold}`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Transaction hash to sign</dt>
              <dd>
                <code>{detail.safe_tx_hash}</code>
              </dd>
            </div>
          </dl>
          <JsonDetails
            label="Review the exact calls and proposed change"
            value={{ kind: detail.kind, ...detail.payload }}
          />
          <JsonDetails
            label="Safe transaction details"
            value={detail.safe_tx}
          />
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
          <Feedback action={action} />
          {detail.status === "pending" && (
            <>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />
                I have reviewed the proposed calls and amounts.
              </label>
              <div className="actions">
                <Button
                  disabled={
                    !ack ||
                    !execution ||
                    !!txHash ||
                    execution.signatures.some(
                      (s: any) =>
                        s.owner.toLowerCase() === account.wallet?.toLowerCase(),
                    )
                  }
                  busy={action.busy}
                  onClick={() => action.run(sign)}
                >
                  Sign approval
                </Button>
                <Button
                  kind="secondary"
                  disabled={!ack || !execution?.ready || !!txHash}
                  busy={action.busy}
                  onClick={() => action.run(execute)}
                >
                  Execute in wallet
                  <ArrowUpRight size={15} />
                </Button>
                <Button
                  kind="ghost"
                  disabled={action.busy}
                  onClick={() => action.run(() => open(detail.id))}
                >
                  <RefreshCw size={15} />
                  Refresh signatures
                </Button>
              </div>
              <details className="recovery">
                <summary>Already executed, or Safe nonce changed?</summary>
                <Field label="Execution transaction hash">
                  <input
                    value={txHash}
                    onChange={(e) => setTxHash(e.target.value.trim())}
                    placeholder="0x…"
                  />
                </Field>
                <Button
                  kind="secondary"
                  disabled={!/^0x[0-9a-fA-F]{64}$/.test(txHash)}
                  busy={action.busy}
                  onClick={() => action.run(confirm)}
                >
                  Check confirmation
                </Button>
                <p className="muted">
                  Confirmation requires a successful Safe execution plus one
                  block. If another transaction changed the Safe nonce, prepare
                  a fresh proposal and collect new signatures.
                </p>
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
              </details>
              {txHash && (
                <div className="notice">
                  <Check size={17} />
                  <span>Submitted: {short(txHash)}</span>
                  <Button
                    kind="secondary"
                    busy={action.busy}
                    onClick={() => action.run(confirm)}
                  >
                    Check confirmation
                  </Button>
                </div>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
