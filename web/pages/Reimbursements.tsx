import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Check,
  CircleCheck,
  HandCoins,
  ImagePlus,
  Plus,
  ReceiptText,
  Wallet,
  X,
} from "lucide-react";
import { useOffice } from "../App";
import { api, date, money, short } from "../api";
import { RHC } from "../../shared/chain";
import {
  Button,
  Empty,
  Feedback,
  Field,
  Panel,
  submit,
  useAction,
} from "../ui";
import { Pill, SidePanel, SideItem, SideSection, Stat } from "../shell";
import "./Reimbursements.css";
// Reimbursements (RELEASED_UPDATES=reimbursements). Rendered inside the update gate in Updates.tsx.
type Request = {
  id: string;
  status: "submitted" | "approved" | "paid" | "rejected" | "withdrawn";
  amount: string;
  vendor: string;
  note: string;
  category: string;
  spentOn: string;
  payoutWallet: string;
  hasReceipt: boolean;
  submittedBy: string;
  mine: boolean;
  createdAt: string;
  reviewedAt: string | null;
  reason: string | null;
  proposalId: string | null;
  transactionHash: string | null;
  paidAt: string | null;
};
type Data = {
  wallet: string | null;
  canSubmit: boolean;
  canReview: boolean;
  categories: string[];
  maxAmount: string;
  safeBalance: string;
  availableBalance: string;
  mine: Request[];
  review: {
    queue: Request[];
    queueTotal: string;
    awaiting: Request[];
    awaitingTotal: string;
    recent: Request[];
  } | null;
};
const STATUS: Record<
  Request["status"],
  { label: string; tone: "green" | "amber" | "red" | "" }
> = {
  submitted: { label: "Waiting for review", tone: "amber" },
  approved: { label: "Awaiting signatures", tone: "amber" },
  paid: { label: "Paid", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
  withdrawn: { label: "Withdrawn", tone: "" },
};
/** The server allows about 700,000 characters; stay well below it. */
const MAX_RECEIPT_CHARS = 600_000;
const AMOUNT = /^\d{1,9}(\.\d{1,6})?$/;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** Adds USDG decimal strings exactly (6 decimals), without floating point. */
function total(values: string[]) {
  const units = values.reduce((sum, v) => {
    const [whole, fraction = ""] = v.split(".");
    return sum + BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  }, 0n);
  const fraction = (units % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${units / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}
/** Shrinks a receipt photo to a JPEG small enough for the API. */
async function downscale(file: File): Promise<string> {
  if (!file.type.startsWith("image/"))
    throw new Error("Choose a photo or image of the receipt.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This image can’t be read here. Try a JPEG or PNG.");
  }
  try {
    let side = 1600,
      quality = 0.82;
    for (let attempt = 0; attempt < 7; attempt++) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height)),
        canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser can’t prepare the image.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length <= MAX_RECEIPT_CHARS) return url;
      side = Math.round(side * 0.8);
      quality = Math.max(0.5, quality - 0.08);
    }
  } finally {
    bitmap.close();
  }
  throw new Error("This receipt image is too large. Try a smaller photo.");
}
const blank = () => ({
  amount: "",
  vendor: "",
  spentOn: today(),
  category: "Software",
  note: "",
});
export function Reimbursements() {
  const { office, navigate } = useOffice(),
    action = useAction(),
    [data, setData] = useState<Data | null>(null),
    [view, setView] = useState<string>(""),
    [form, setForm] = useState(blank),
    [receipt, setReceipt] = useState(""),
    [reading, setReading] = useState(false),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [reason, setReason] = useState(""),
    [rejecting, setRejecting] = useState(false),
    [image, setImage] = useState<{ id: string; url: string } | null>(null);
  async function load() {
    const next: Data = await api.office(office.id, "/reimbursements");
    setData(next);
    setSelected(
      (s) =>
        new Set(
          [...s].filter((id) => next.review?.queue.some((r) => r.id === id)),
        ),
    );
    return next;
  }
  useEffect(() => {
    if (office.role === "guest") return;
    void action.run(async () => {
      const next = await load();
      setView(next.review?.queue.length ? "review" : "new");
    });
  }, [office.id]);
  const all = new Map<string, Request>();
  for (const r of [
    ...(data?.review?.queue || []),
    ...(data?.review?.awaiting || []),
    ...(data?.review?.recent || []),
    ...(data?.mine || []),
  ])
    all.set(r.id, r);
  const current = all.get(view) || null;
  useEffect(() => {
    setReason("");
    setRejecting(false);
    if (!current?.hasReceipt || image?.id === current.id) return;
    setImage(null);
    void action.run(async () => {
      const { image: url } = await api.office(
        office.id,
        `/reimbursements/${current.id}/receipt`,
      );
      setImage({ id: current.id, url });
    });
  }, [current?.id]);
  if (office.role === "guest")
    return (
      <>
        <SidePanel title="Reimbursements" />
        <Empty
          title="Reimbursements are for Office members."
          icon={<HandCoins />}
        >
          Your guest access covers your invited Rooms only.
        </Empty>
      </>
    );
  function open(id: string) {
    action.setNotice("");
    action.setError("");
    setView(id);
  }
  async function attach(file: File | undefined) {
    if (!file) return;
    setReading(true);
    try {
      setReceipt(await downscale(file));
    } finally {
      setReading(false);
    }
  }
  async function send() {
    if (!AMOUNT.test(form.amount) || !/[1-9]/.test(form.amount))
      throw new Error("Enter an amount above zero, like 24.99.");
    const created = await api.office(office.id, "/reimbursements", {
      ...form,
      vendor: form.vendor.trim(),
      note: form.note.trim(),
      ...(receipt ? { receipt } : {}),
    });
    setForm(blank());
    setReceipt("");
    await load();
    setView(created.id);
    action.setNotice("Request sent. An Officer or Principal will review it.");
  }
  async function approve(ids: string[]) {
    const result = await api.office(office.id, "/reimbursements/approve", {
      ids,
    });
    setSelected(new Set());
    await load();
    action.setNotice(
      `Sent ${ids.length === 1 ? "1 payment" : `${ids.length} payments`} (${money(result.totalUsdg)} USDG) to the Safe owners for signatures.`,
    );
  }
  async function reject(id: string) {
    await api.office(office.id, `/reimbursements/${id}/reject`, { reason });
    await load();
    action.setNotice("Request rejected. The member can see your reason.");
  }
  async function withdraw(id: string) {
    await api.office(office.id, `/reimbursements/${id}/withdraw`, {});
    await load();
    action.setNotice("Request withdrawn.");
  }
  const review = data?.review,
    queue = review?.queue || [],
    picked = queue.filter((r) => selected.has(r.id)),
    explorer = RHC.blockExplorers.default.url,
    principal = office.role === "principal";
  const item = (r: Request, showWho: boolean) => (
    <SideItem
      key={r.id}
      active={view === r.id}
      title={r.vendor}
      meta={`${showWho ? `${r.mine ? "You" : short(r.payoutWallet)} · ` : ""}${r.spentOn}`}
      trailing={
        <span className="reimb-side-amount">
          {money(r.amount)}
          {!showWho && (
            <Pill tone={STATUS[r.status].tone}>
              {r.status === "submitted" ? "In review" : STATUS[r.status].label}
            </Pill>
          )}
        </span>
      }
      onClick={() => open(r.id)}
    />
  );
  return (
    <div className="reimb-page">
      <SidePanel title="Reimbursements">
        <button
          className="side-new"
          onClick={() => open("new")}
          aria-current={view === "new" ? "true" : undefined}
        >
          <Plus size={16} /> Request reimbursement
        </button>
        {review && (
          <SideSection label="Review">
            <SideItem
              active={view === "review"}
              leading={<ReceiptText size={15} />}
              title="To review"
              meta={
                queue.length ? `${money(review.queueTotal)} USDG` : "All clear"
              }
              trailing={
                queue.length ? (
                  <span className="count">{queue.length}</span>
                ) : undefined
              }
              onClick={() => open("review")}
            />
            {review.awaiting.map((r) => item(r, true))}
          </SideSection>
        )}
        <SideSection label="My requests">
          {data?.mine.length ? (
            data.mine.map((r) => item(r, false))
          ) : (
            <p className="side-note">Requests you send appear here.</p>
          )}
        </SideSection>
      </SidePanel>
      <Feedback action={action} />
      {!data ? null : view === "review" && review ? (
        <div className="detail-page">
          <header className="page-heading">
            <div>
              <span className="eyebrow">Reimbursements</span>
              <h1>To review</h1>
              <p>
                Approving sends a USDG payment to the member’s wallet for the
                Safe owners to sign in Approvals.
              </p>
            </div>
          </header>
          <div className="stat-row reimb-stats">
            <Stat
              label="Waiting for review"
              value={money(review.queueTotal)}
              unit="USDG"
              hint={`${queue.length} request${queue.length === 1 ? "" : "s"}`}
            />
            <Stat
              label="Awaiting signatures"
              value={money(review.awaitingTotal)}
              unit="USDG"
              hint={`${review.awaiting.length} approved`}
            />
            <Stat
              label="Available in the Safe"
              value={money(data.availableBalance)}
              unit="USDG"
              hint={`${money(data.safeBalance)} USDG held`}
            />
          </div>
          <div className="table-card">
            {queue.length ? (
              <>
                <div className="table-scroll">
                  <table className="table">
                    <thead>
                      <tr>
                        <th className="reimb-check">
                          <input
                            type="checkbox"
                            aria-label="Select all requests"
                            checked={picked.length === queue.length}
                            onChange={(e) =>
                              setSelected(
                                new Set(
                                  e.target.checked
                                    ? queue.slice(0, 20).map((r) => r.id)
                                    : [],
                                ),
                              )
                            }
                          />
                        </th>
                        <th>Member</th>
                        <th>Paid to</th>
                        <th>Category</th>
                        <th>Date</th>
                        <th className="num">Amount (USDG)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {queue.map((r) => (
                        <tr
                          key={r.id}
                          className="clickable"
                          onClick={() => open(r.id)}
                        >
                          <td
                            className="reimb-check"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              aria-label={`Select ${r.vendor}`}
                              disabled={r.mine && !principal}
                              checked={selected.has(r.id)}
                              onChange={(e) => {
                                const next = new Set(selected);
                                if (e.target.checked) next.add(r.id);
                                else next.delete(r.id);
                                setSelected(next);
                              }}
                            />
                          </td>
                          <td>
                            {r.mine ? (
                              "You"
                            ) : (
                              <code>{short(r.payoutWallet)}</code>
                            )}
                          </td>
                          <td>
                            {r.vendor}
                            {r.hasReceipt && <small>Receipt attached</small>}
                          </td>
                          <td>{r.category}</td>
                          <td className="nowrap">{r.spentOn}</td>
                          <td className="num">{money(r.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="table-foot">
                  <span className="muted">
                    {picked.length
                      ? `${picked.length} selected · ${money(total(picked.map((r) => r.amount)))} USDG`
                      : "Select requests to pay them together in one Safe transaction."}
                  </span>
                  <Button
                    disabled={!picked.length || picked.length > 20}
                    busy={action.busy}
                    onClick={() =>
                      action.run(() => approve(picked.map((r) => r.id)))
                    }
                  >
                    <Check size={15} /> Approve selected
                  </Button>
                </div>
              </>
            ) : (
              <p className="card-empty">
                <CircleCheck size={15} /> Nothing waiting for review.
              </p>
            )}
          </div>
          {principal && review.awaiting.length > 0 && (
            <div className="safe-strip">
              <Wallet size={16} />
              <span>
                {review.awaiting.length} approved payment
                {review.awaiting.length === 1 ? " is" : "s are"} waiting for
                Safe owner signatures.
              </span>
              <button className="link" onClick={() => navigate("proposals")}>
                Open Approvals <ArrowUpRight size={13} />
              </button>
            </div>
          )}
        </div>
      ) : current ? (
        <div className="detail-page">
          <nav className="crumbs">
            <span>Reimbursements</span>
            <span>/</span>
            <strong>{current.vendor}</strong>
          </nav>
          <header className="detail-head">
            <div>
              <h1>
                {money(current.amount)}{" "}
                <small className="reimb-unit">USDG</small>
              </h1>
              <p>
                {current.vendor} · {current.category} · {current.spentOn}
              </p>
            </div>
            <Pill tone={STATUS[current.status].tone}>
              {STATUS[current.status].label}
            </Pill>
          </header>
          {current.status === "approved" && (
            <div className="notice warning">
              <span>
                Approved. The payment is waiting for the Safe owners to sign and
                execute it in Approvals.
              </span>
              {principal && (
                <button className="link" onClick={() => navigate("proposals")}>
                  Open Approvals
                </button>
              )}
            </div>
          )}
          {current.status === "approved" &&
            ["principal", "officer"].includes(office.role) && (
              <Button
                kind="secondary"
                busy={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await api.office(
                      office.id,
                      `/reimbursements/${current.id}/return-to-review`,
                      {},
                    );
                    await load();
                    action.setNotice(
                      "The stale payout batch is back in review. It requires a new approval.",
                    );
                  })
                }
              >
                Return stale batch to review
              </Button>
            )}
          {current.status === "rejected" && current.reason && (
            <div className="notice error">
              <span>Rejected: {current.reason}</span>
            </div>
          )}
          <div className="reimb-detail">
            <Panel className="card">
              <dl className="kv">
                <div>
                  <dt>Amount</dt>
                  <dd>{money(current.amount)} USDG</dd>
                </div>
                <div>
                  <dt>Vendor</dt>
                  <dd>{current.vendor}</dd>
                </div>
                <div>
                  <dt>Category</dt>
                  <dd>{current.category}</dd>
                </div>
                <div>
                  <dt>Receipt date</dt>
                  <dd>{current.spentOn}</dd>
                </div>
                <div>
                  <dt>Requested by</dt>
                  <dd>{current.mine ? "You" : short(current.payoutWallet)}</dd>
                </div>
                <div>
                  <dt>Paid to</dt>
                  <dd>
                    <code title={current.payoutWallet}>
                      {short(current.payoutWallet)}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>Sent</dt>
                  <dd>{date(current.createdAt)}</dd>
                </div>
                {current.note && (
                  <div>
                    <dt>Note</dt>
                    <dd className="reimb-note">{current.note}</dd>
                  </div>
                )}
                {current.transactionHash && (
                  <div>
                    <dt>Payment</dt>
                    <dd>
                      <a
                        className="link"
                        href={`${explorer}/tx/${current.transactionHash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {short(current.transactionHash)}{" "}
                        <ArrowUpRight size={13} />
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
            </Panel>
            <Panel className="card reimb-receipt">
              {!current.hasReceipt ? (
                <p className="card-empty">No receipt attached.</p>
              ) : image?.id === current.id ? (
                <a href={image.url} target="_blank" rel="noreferrer">
                  <img src={image.url} alt={`Receipt from ${current.vendor}`} />
                </a>
              ) : (
                <p className="card-empty">Loading receipt…</p>
              )}
            </Panel>
          </div>
          {current.status === "submitted" &&
            (review && (!current.mine || principal) ? (
              rejecting ? (
                <form
                  className="action-bar"
                  onSubmit={submit(() => action.run(() => reject(current.id)))}
                >
                  <input
                    className="grow"
                    autoFocus
                    required
                    maxLength={500}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Reason the member will see"
                    aria-label="Reason for rejecting"
                  />
                  <Button
                    type="button"
                    kind="ghost"
                    onClick={() => setRejecting(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    kind="danger"
                    type="submit"
                    busy={action.busy}
                    disabled={!reason.trim()}
                  >
                    Reject
                  </Button>
                </form>
              ) : (
                <div className="action-bar">
                  <span className="muted grow">
                    Approving pays {money(current.amount)} USDG to{" "}
                    {short(current.payoutWallet)} after the Safe owners sign.
                  </span>
                  <Button kind="secondary" onClick={() => setRejecting(true)}>
                    <X size={15} /> Reject
                  </Button>
                  <Button
                    busy={action.busy}
                    onClick={() => action.run(() => approve([current.id]))}
                  >
                    <Check size={15} /> Approve
                  </Button>
                </div>
              )
            ) : current.mine ? (
              <div className="action-bar">
                <span className="muted grow">
                  {review
                    ? "Another Officer or a Principal must approve your own request."
                    : "An Officer or Principal will review this request."}
                </span>
                <Button
                  kind="ghost"
                  busy={action.busy}
                  onClick={() => action.run(() => withdraw(current.id))}
                >
                  Withdraw
                </Button>
              </div>
            ) : null)}
        </div>
      ) : (
        <div className="detail-page">
          <header className="page-heading">
            <div>
              <span className="eyebrow">Reimbursements</span>
              <h1>Request reimbursement</h1>
              <p>
                Paid for something for the Office? Send the receipt and get paid
                back in USDG once the Safe owners approve.
              </p>
            </div>
          </header>
          {!data.wallet ? (
            <div className="notice warning">
              <Wallet size={17} />
              <span>
                Payouts go only to a verified wallet. Sign out, then sign in to
                Chancery with your wallet instead of a passkey to request a
                reimbursement.
              </span>
            </div>
          ) : (
            !data.canSubmit && (
              <div className="notice warning">
                <span>
                  The Office must be open before reimbursements can be paid.
                </span>
              </div>
            )
          )}
          <Panel className="card">
            <form
              onSubmit={submit(() => action.run(send))}
              aria-disabled={!data.canSubmit}
            >
              <fieldset
                disabled={!data.canSubmit || action.busy}
                className="reimb-form"
              >
                <div className="form-grid">
                  <Field
                    label="Amount · USDG"
                    help={`Up to ${money(data.maxAmount, 0)} USDG`}
                  >
                    <input
                      required
                      inputMode="decimal"
                      placeholder="0.00"
                      pattern="\d{1,9}(\.\d{1,6})?"
                      value={form.amount}
                      onChange={(e) =>
                        setForm({ ...form, amount: e.target.value.trim() })
                      }
                    />
                  </Field>
                  <Field label="Vendor">
                    <input
                      required
                      maxLength={120}
                      placeholder="Who you paid"
                      value={form.vendor}
                      onChange={(e) =>
                        setForm({ ...form, vendor: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Date on the receipt">
                    <input
                      required
                      type="date"
                      max={today()}
                      value={form.spentOn}
                      onChange={(e) =>
                        setForm({ ...form, spentOn: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Category">
                    <select
                      value={form.category}
                      onChange={(e) =>
                        setForm({ ...form, category: e.target.value })
                      }
                    >
                      {data.categories.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label="Note" help="Optional. What was it for?">
                  <textarea
                    rows={3}
                    maxLength={1000}
                    value={form.note}
                    onChange={(e) => setForm({ ...form, note: e.target.value })}
                  />
                </Field>
                <div className="reimb-upload">
                  {receipt ? (
                    <div className="reimb-preview">
                      <img src={receipt} alt="Receipt preview" />
                      <Button
                        type="button"
                        kind="ghost"
                        onClick={() => setReceipt("")}
                      >
                        <X size={15} /> Remove
                      </Button>
                    </div>
                  ) : (
                    <label className="reimb-drop">
                      <ImagePlus size={20} />
                      <span>
                        <strong>
                          {reading ? "Preparing image…" : "Add a receipt photo"}
                        </strong>
                        <small>
                          Optional. It is shrunk on this device and stored
                          encrypted.
                        </small>
                      </span>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          void action.run(() => attach(file));
                        }}
                      />
                    </label>
                  )}
                </div>
                <div className="reimb-actions">
                  <span className="muted grow">
                    {data.wallet
                      ? `Paid to your wallet ${short(data.wallet)}`
                      : "Connect a wallet to continue."}
                  </span>
                  <Button type="submit" busy={action.busy} disabled={reading}>
                    Send request
                  </Button>
                </div>
              </fieldset>
            </form>
          </Panel>
        </div>
      )}
    </div>
  );
}
