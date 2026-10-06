import { useEffect, useState } from "react";
import {
  Download,
  FileCheck2,
  ReceiptText,
  RefreshCw,
  ExternalLink,
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
import {
  Badge,
  Button,
  Empty,
  Feedback,
  JsonDetails,
  Modal,
  PageTitle,
  Panel,
  useAction,
} from "../ui";
import { RHC } from "../../shared/chain";
export function Ledger() {
  const { office } = useOffice(),
    action = useAction(),
    [month, setMonth] = useState(new Date().toISOString().slice(0, 7)),
    [rows, setRows] = useState<Receipt[]>([]),
    [proof, setProof] = useState<any>(null),
    [verification, setVerification] = useState<any>(null);
  const load = async () =>
    setRows(await api.office(office.id, `/ledger?month=${month}`));
  useEffect(() => {
    if (office.status === "active") void action.run(load);
  }, [office.id, month, office.status]);
  if (office.role === "guest")
    return (
      <Empty title="A little privacy for your team." icon={<ReceiptText />}>
        Your guest access covers your invited Rooms. The Ledger is available to
        Office members.
      </Empty>
    );
  return (
    <>
      <PageTitle
        eyebrow="A RECORD YOU CAN VERIFY"
        title="Every cent. Accounted for."
        actions={
          <>
            <Button
              kind="secondary"
              disabled={!rows.length}
              onClick={() =>
                action.run(() => exportLedger(office.id, month, "csv"))
              }
            >
              <Download size={16} />
              Export CSV
            </Button>
            <Button
              kind="secondary"
              disabled={!rows.length}
              onClick={() =>
                action.run(() => exportLedger(office.id, month, "json"))
              }
            >
              JSON
            </Button>
          </>
        }
      >
        Signed receipts for{" "}
        {office.role === "member" ? "your" : "your Office’s"} AI usage and seat
        charges.
      </PageTitle>
      <Feedback action={action} />
      <Panel>
        <div className="ledger-toolbar">
          <label className="month-field">
            Statement month
            <input
              type="month"
              aria-label="Statement month"
              value={month}
              onChange={(e) => {
                if (e.target.value) setMonth(e.target.value);
              }}
            />
          </label>
          <span className="muted">
            {rows.length} receipts
            {rows.length === 5000 ? " · Export for the full statement" : ""}
          </span>
          <Button
            kind="ghost"
            busy={action.busy}
            onClick={() => action.run(load)}
          >
            <RefreshCw size={16} />
            Refresh
          </Button>
        </div>
        {rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Activity</th>
                  <th>Actor</th>
                  <th>Cost · USDG</th>
                  <th>Status</th>
                  <th>Record</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>
                        {r.envelope.payload.model || "Workspace seats"}
                      </strong>
                      <small>{date(r.created_at)}</small>
                    </td>
                    <td>
                      <code>{short(r.envelope.payload.actorId)}</code>
                    </td>
                    <td className="number">
                      {money(r.envelope.payload.chargedUsd)}
                      <small>
                        {r.envelope.payload.providerUsd !== undefined
                          ? `Provider ${money(r.envelope.payload.providerUsd)}`
                          : ""}
                      </small>
                    </td>
                    <td>
                      <Badge
                        tone={
                          r.envelope.payload.status === "complete"
                            ? "green"
                            : ""
                        }
                      >
                        {r.envelope.payload.status || r.envelope.payload.type}
                      </Badge>
                      <small>
                        {r.settlement_id
                          ? "Settlement recorded"
                          : "Awaiting settlement"}
                      </small>
                    </td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() =>
                          action.run(async () => {
                            setVerification(null);
                            setProof(
                              await api.office(
                                office.id,
                                `/ledger/${r.id}/proof`,
                              ),
                            );
                          })
                        }
                      >
                        <FileCheck2 size={15} />
                        View receipt
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon={<ReceiptText />}
            title={action.busy ? "Loading your statement…" : "A clean slate."}
          >
            Receipts appear after paid AI requests or seat charges. Use the
            month selector to look back.
          </Empty>
        )}
      </Panel>
      {proof && (
        <Modal title="Your signed receipt" close={() => setProof(null)}>
          <dl className="detail-list">
            <div>
              <dt>Model / charge</dt>
              <dd>
                {proof.envelope.payload.model || proof.envelope.payload.type}
              </dd>
            </div>
            <div>
              <dt>Charged</dt>
              <dd>{money(proof.envelope.payload.chargedUsd, 6)} USDG</dd>
            </div>
            <div>
              <dt>Anchor</dt>
              <dd>{proof.anchor?.status || "Not anchored yet"}</dd>
            </div>
            <div>
              <dt>Settlement</dt>
              <dd>{proof.settlement?.status || "Not settled yet"}</dd>
            </div>
          </dl>
          {[proof.anchor, proof.settlement]
            .filter((p) => p?.transactionHash)
            .map((p, i) => (
              <a
                key={i}
                className="text-button"
                href={`${RHC.blockExplorers.default.url}/tx/${p.transactionHash}`}
                target="_blank"
                rel="noreferrer"
              >
                View {i === 0 ? "anchor" : "settlement"} transaction
                <ExternalLink size={14} />
              </a>
            ))}
          <div className="actions">
            <Button
              kind="secondary"
              onClick={() =>
                action.run(async () => {
                  const anchor = proof.anchor || proof.settlement;
                  setVerification(
                    await api.request("/verify", {
                      envelope: proof.envelope,
                      ...(anchor
                        ? {
                            leaf: proof.leaf,
                            root: anchor.root,
                            proof: anchor.proof,
                          }
                        : {}),
                    }),
                  );
                })
              }
            >
              Verify signature
            </Button>
            <Button
              kind="ghost"
              onClick={() => download("chancery-receipt.json", proof)}
            >
              <Download size={15} />
              Download proof
            </Button>
          </div>
          {verification && (
            <div
              className={`notice ${verification.valid ? "success" : "error"}`}
              role="status"
            >
              <FileCheck2 size={18} />
              <span>
                {verification.valid
                  ? "Receipt signature is valid."
                  : "Receipt signature could not be verified."}
                {verification.proofValid !== null
                  ? ` Merkle proof ${verification.proofValid ? "matches" : "does not match"}.`
                  : ""}{" "}
                Check the linked transaction for onchain confirmation.
              </span>
            </div>
          )}
          <Feedback action={action} />
          <JsonDetails value={proof} label="Full receipt and proof" />
        </Modal>
      )}
    </>
  );
}
