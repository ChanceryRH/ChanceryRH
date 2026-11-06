import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
  ArrowRight,
  BookOpen,
  Copy,
  FileText,
  Megaphone,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Wand2,
} from "lucide-react";
import { useOffice } from "../App";
import { api, date, money, short, ChanceryError } from "../api";
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
import { Pill, SidePanel, SideItem, SideSection } from "../shell";
import { sentence, shortId } from "../data";
import "./Playbooks.css";
// Playbooks (RELEASED_UPDATES=playbooks). Rendered inside the update gate in Updates.tsx.

type PlaybookField = { name: string; label: string; multiline: boolean };
type Playbook = {
  id: string;
  name: string;
  description: string;
  template: string;
  fields: PlaybookField[];
  model: string;
  maxTokens: number;
  maxPriceUsd: string;
  status: "active" | "archived";
  starter: string | null;
  version: number;
  updatedAt: string;
};
type Starter = { key: string; name: string; description: string };
type Run = {
  id: string;
  playbookId: string;
  requestId: string;
  status: "complete" | "pending" | "failed" | "blocked";
  runBy: { you: boolean; label: string; role: string | null };
  createdAt: string;
  ceilingUsd: string;
  quotedUsd: string | null;
  chargedUsd: string | null;
  receiptId: string | null;
  receipt: any;
  error: string | null;
  inputs: Record<string, string> | null;
  output: string | null;
  retained: boolean;
};
type Listing = {
  playbooks: Playbook[];
  starters: Starter[];
  canManage: boolean;
  maxRequestUsd: string;
};

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g;
const LENGTHS = [
  { tokens: 512, label: "Short · about 300 words" },
  { tokens: 1024, label: "Medium · about 700 words" },
  { tokens: 2048, label: "Long · about 1,400 words" },
];
const starterIcons: Record<string, typeof FileText> = {
  summarize_document: FileText,
  weekly_update: Megaphone,
  explain_transaction: ShieldCheck,
};
const statusTone = (s: Run["status"]) =>
  s === "complete" ? "green" : s === "pending" ? "amber" : "red";
const statusLabel = (s: Run["status"]) =>
  s === "complete"
    ? "Done"
    : s === "pending"
      ? "Pending"
      : s === "blocked"
        ? "Over limit"
        : "Failed";
const errorLabel: Record<string, string> = {
  over_ceiling: "It could have cost more than the price limit, so it wasn’t sent.",
  playbook_changed: "The Playbook changed while it was starting. Nothing was charged.",
  not_sent: "This run was never sent. Nothing was charged.",
};
const fieldNames = (template: string) => [
  ...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1])),
];
const fill = (template: string, values: Record<string, string>) =>
  template.replace(PLACEHOLDER, (_, n: string) => values[n] ?? "");
const usd = (value: string | null | undefined) => {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return n > 0 && n < 0.01 ? money(value, 6) : money(value, 2);
};
const newId = () => crypto.randomUUID();

export function Playbooks() {
  const { office, models, navigate } = useOffice(),
    action = useAction();
  const [data, setData] = useState<Listing | null>(null),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [editing, setEditing] = useState<Playbook | "new" | null>(null);
  const available = models.filter(
    (m) =>
      (!office.policy.allowedModels.length ||
        office.policy.allowedModels.includes(m.id)) &&
      m.lanes.some((l) => office.policy.allowedLanes.includes(l)),
  );
  const names = useMemo(
    () => new Map(models.map((m) => [m.id, m.name])),
    [models],
  );
  async function load() {
    const next: Listing = await api.office(office.id, "/playbooks");
    setData(next);
    return next;
  }
  useEffect(() => {
    void action.run(load);
  }, [office.id]);
  const active = data?.playbooks.filter((p) => p.status === "active") || [],
    archived = data?.playbooks.filter((p) => p.status === "archived") || [],
    selected =
      data?.playbooks.find((p) => p.id === selectedId) || active[0] || null,
    canManage = !!data?.canManage;
  async function addStarter(key: string) {
    if (!available[0])
      throw new Error(
        "No AI model is available for this Office yet. Check the Office policy in Settings.",
      );
    const created: Playbook = await api.office(
      office.id,
      "/playbooks/starters",
      { starter: key, model: available[0].id },
    );
    await load();
    setSelectedId(created.id);
    action.setNotice(
      `“${created.name}” is ready. Each run costs at most ${usd(created.maxPriceUsd)} USDG.`,
    );
  }
  const starters = data && canManage && (
    <div className="starter-grid">
      {data.starters.map((s) => {
        const Icon = starterIcons[s.key] || Sparkles,
          added = data.playbooks.some(
            (p) => p.starter === s.key && p.status === "active",
          );
        return (
          <div className="starter-card" key={s.key}>
            <span className="starter-icon">
              <Icon size={16} />
            </span>
            <strong>{s.name}</strong>
            <span>{s.description}</span>
            <Button
              kind="secondary"
              disabled={action.busy || !available.length}
              onClick={() => action.run(() => addStarter(s.key))}
            >
              <Plus size={14} />
              {added ? "Add another" : "Add"}
            </Button>
          </div>
        );
      })}
    </div>
  );
  return (
    <div className="playbooks-page">
      <SidePanel
        title="Playbooks"
        action={
          <button
            className="icon-button"
            aria-label="Refresh Playbooks"
            title="Refresh"
            disabled={action.busy}
            onClick={() => action.run(load)}
          >
            <RefreshCw size={15} />
          </button>
        }
      >
        {canManage && (
          <button className="side-new" onClick={() => setEditing("new")}>
            <Plus size={15} />
            New Playbook
          </button>
        )}
        <SideSection>
          {active.length ? (
            active.map((p) => (
              <SideItem
                key={p.id}
                active={selected?.id === p.id}
                title={p.name}
                meta={`Up to ${usd(p.maxPriceUsd)} USDG · ${names.get(p.model) || p.model}`}
                onClick={() => setSelectedId(p.id)}
              />
            ))
          ) : (
            <p className="side-note">
              {data
                ? "Approved AI tasks appear here."
                : "Loading Playbooks…"}
            </p>
          )}
        </SideSection>
        {canManage && archived.length > 0 && (
          <SideSection label="Archived">
            {archived.map((p) => (
              <SideItem
                key={p.id}
                active={selected?.id === p.id}
                title={p.name}
                meta="Archived · members can’t run it"
                onClick={() => setSelectedId(p.id)}
              />
            ))}
          </SideSection>
        )}
      </SidePanel>
      {!editing && <Feedback action={action} />}
      {!data ? null : !selected ? (
        canManage ? (
          <div className="detail-page">
            <header className="detail-head">
              <div>
                <h1>Playbooks</h1>
                <p>
                  Set up AI tasks once. Anyone in the Office can then run them
                  in one click, with a set model and a fixed price limit.
                </p>
              </div>
            </header>
            <Panel className="card">
              <div className="card-head">
                <div>
                  <h2>Start with a ready-made Playbook</h2>
                  <p>
                    Add one in a click. You can change the wording, model or
                    price limit later.
                  </p>
                </div>
              </div>
              {starters}
              {!available.length && (
                <p className="card-empty">
                  No AI model is available for this Office yet. Check the
                  Office policy in Settings.
                </p>
              )}
            </Panel>
            <div className="safe-strip">
              <Wand2 size={16} />
              <span>Prefer your own wording?</span>
              <button className="link" onClick={() => setEditing("new")}>
                Write a Playbook <ArrowRight size={13} />
              </button>
            </div>
          </div>
        ) : (
          <Empty title="No Playbooks yet." icon={<BookOpen />}>
            Playbooks are AI tasks your Officers set up in advance. Ask an
            Officer to add one, then run it here in one click.
          </Empty>
        )
      ) : (
        <PlaybookDetail
          key={selected.id}
          playbook={selected}
          canManage={canManage}
          modelName={names.get(selected.model) || selected.model}
          busy={action.busy}
          onEdit={() => setEditing(selected)}
          onStatus={(status) =>
            action.run(async () => {
              await api.office(
                office.id,
                `/playbooks/${selected.id}/${status === "archived" ? "archive" : "restore"}`,
                {},
              );
              await load();
              action.setNotice(
                status === "archived"
                  ? "Archived. Members can no longer run it; its history is kept."
                  : "Restored. Members can run it again.",
              );
            })
          }
          openLedger={() => navigate("ledger")}
          starters={active.length < 3 ? starters : null}
        />
      )}
      {editing && data && (
        <Editor
          playbook={editing === "new" ? null : editing}
          available={available}
          maxRequestUsd={data.maxRequestUsd}
          close={() => setEditing(null)}
          saved={async (p) => {
            setEditing(null);
            await action.run(load);
            setSelectedId(p.id);
            action.setNotice(`Saved “${p.name}”.`);
          }}
        />
      )}
    </div>
  );
}

function PlaybookDetail({
  playbook,
  canManage,
  modelName,
  busy,
  onEdit,
  onStatus,
  openLedger,
  starters,
}: {
  playbook: Playbook;
  canManage: boolean;
  modelName: string;
  busy: boolean;
  onEdit: () => void;
  onStatus: (status: "active" | "archived") => void;
  openLedger: () => void;
  starters: React.ReactNode;
}) {
  const { office } = useOffice(),
    action = useAction();
  const [values, setValues] = useState<Record<string, string>>({}),
    [runs, setRuns] = useState<Run[]>([]),
    [shown, setShown] = useState<Run | null>(null);
  async function loadRuns() {
    setRuns(await api.office(office.id, `/playbooks/${playbook.id}/runs`));
  }
  useEffect(() => {
    void action.run(loadRuns);
  }, [playbook.id]);
  const prompt = fill(playbook.template, values),
    guard = checkGuards(prompt),
    missing = playbook.fields.filter((f) => !(values[f.name] || "").trim()),
    ready =
      office.status === "active" &&
      office.seatStatus === "active" &&
      office.moduleEnabled &&
      playbook.status === "active";
  async function run() {
    if (guard) throw new Error(guard.message);
    try {
      const result: Run = await api.office(
        office.id,
        `/playbooks/${playbook.id}/run`,
        { id: newId(), fields: values },
      );
      setShown(result);
      if (result.status === "complete") setValues({});
    } catch (error) {
      if (
        !(error instanceof ChanceryError) ||
        error.status >= 500 ||
        error.code === "over_ceiling"
      )
        await loadRuns().catch(() => {});
      if (!(error instanceof ChanceryError) || error.status >= 500)
        throw new Error(
          "We couldn’t confirm this run. Check Recent runs below before trying again.",
        );
      throw error;
    }
    await loadRuns();
  }
  async function copy(text: string, what: string) {
    await navigator.clipboard.writeText(text);
    action.setNotice(`${what} copied.`);
  }
  const length =
    LENGTHS.find((l) => l.tokens === playbook.maxTokens)?.label.split(" · ")[0] ||
    `${playbook.maxTokens} tokens`;
  return (
    <div className="detail-page">
      <header className="detail-head">
        <div>
          <h1>{playbook.name}</h1>
          {playbook.description && <p>{playbook.description}</p>}
        </div>
        {canManage && (
          <div className="head-actions">
            {playbook.status === "archived" && <Pill>Archived</Pill>}
            <Button kind="secondary" disabled={busy} onClick={onEdit}>
              <Pencil size={14} />
              Edit
            </Button>
            {playbook.status === "active" ? (
              <Button
                kind="ghost"
                disabled={busy}
                onClick={() => onStatus("archived")}
              >
                <Archive size={14} />
                Archive
              </Button>
            ) : (
              <Button
                kind="secondary"
                disabled={busy}
                onClick={() => onStatus("active")}
              >
                <RotateCcw size={14} />
                Restore
              </Button>
            )}
          </div>
        )}
      </header>
      <Feedback action={action} />
      <Panel className="card playbook-run">
        <form
          onSubmit={submit(() => {
            if (!missing.length && !guard && ready) void action.run(run);
          })}
        >
          {playbook.fields.length ? (
            playbook.fields.map((f) => (
              <Field key={f.name} label={f.label}>
                {f.multiline ? (
                  <textarea
                    rows={5}
                    maxLength={20000}
                    value={values[f.name] || ""}
                    disabled={action.busy}
                    onChange={(e) =>
                      setValues({ ...values, [f.name]: e.target.value })
                    }
                  />
                ) : (
                  <input
                    maxLength={2000}
                    value={values[f.name] || ""}
                    disabled={action.busy}
                    onChange={(e) =>
                      setValues({ ...values, [f.name]: e.target.value })
                    }
                  />
                )}
              </Field>
            ))
          ) : (
            <p className="muted">This Playbook needs no input. Just run it.</p>
          )}
          {guard && (
            <div className="guard-message" role="alert">
              <ShieldCheck size={14} />
              {guard.message}
            </div>
          )}
          <div className="run-bar">
            <Button
              type="submit"
              busy={action.busy}
              disabled={!ready || !!missing.length || !!guard}
            >
              <Play size={14} />
              Run for up to {usd(playbook.maxPriceUsd)} USDG
            </Button>
            <span className="muted">
              {modelName} · {length} answer · you pay only what it actually
              costs, from your seat’s budget
            </span>
          </div>
          {!ready && (
            <p className="muted run-note">
              {playbook.status === "archived"
                ? "Restore this Playbook to run it."
                : "Your Office and seat must be active before you can run Playbooks."}
            </p>
          )}
        </form>
      </Panel>
      {shown && <Result run={shown} copy={copy} openLedger={openLedger} />}
      <Panel className="card">
        <div className="card-head">
          <div>
            <h2>Recent runs</h2>
            <p>
              {canManage
                ? "Everyone’s runs of this Playbook. Answers are visible only to the person who ran it."
                : "Your runs of this Playbook."}
            </p>
          </div>
          <button className="link" onClick={openLedger}>
            Open ledger <ArrowRight size={13} />
          </button>
        </div>
        {runs.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  {canManage && <th>Who</th>}
                  <th className="num">Cost (USDG)</th>
                  <th>Status</th>
                  <th>Receipt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className={shown?.id === r.id ? "selected" : ""}>
                    <td>{date(r.createdAt)}</td>
                    {canManage && (
                      <td>
                        {r.runBy.you
                          ? "You"
                          : r.runBy.label.startsWith("0x")
                            ? short(r.runBy.label)
                            : r.runBy.label}
                      </td>
                    )}
                    <td className="num">
                      {r.chargedUsd === null ? "—" : usd(r.chargedUsd)}
                    </td>
                    <td>
                      <Pill tone={statusTone(r.status)}>
                        {statusLabel(r.status)}
                      </Pill>
                    </td>
                    <td>
                      {r.receiptId ? <code>{shortId(r.receiptId)}</code> : "—"}
                    </td>
                    <td className="end">
                      {r.runBy.you && (
                        <button className="link" onClick={() => setShown(r)}>
                          View
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="card-empty">
            No runs yet. Fill in the form above and press Run.
          </p>
        )}
      </Panel>
      <details className="json-details playbook-template">
        <summary>What gets sent to the AI</summary>
        <pre>{playbook.template}</pre>
      </details>
      {starters && (
        <Panel className="card">
          <div className="card-head">
            <div>
              <h2>More ready-made Playbooks</h2>
              <p>Add one in a click.</p>
            </div>
          </div>
          {starters}
        </Panel>
      )}
    </div>
  );
}

function Result({
  run,
  copy,
  openLedger,
}: {
  run: Run;
  copy: (text: string, what: string) => Promise<void>;
  openLedger: () => void;
}) {
  const action = useAction();
  return (
    <Panel className="card playbook-result">
      <div className="card-head">
        <div>
          <h2>Result</h2>
          <p>
            {date(run.createdAt)}
            {run.chargedUsd !== null &&
              ` · cost ${usd(run.chargedUsd)} USDG of a ${usd(run.ceilingUsd)} limit`}
          </p>
        </div>
        <Pill tone={statusTone(run.status)}>{statusLabel(run.status)}</Pill>
      </div>
      <Feedback action={action} />
      {run.output ? (
        <div className="markdown playbook-output">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              img: () => null,
              a: ({ children, href }) => (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {run.output}
          </Markdown>
        </div>
      ) : run.status === "complete" ? (
        <p className="muted">
          {run.retained
            ? "The answer is no longer available."
            : "This Office uses zero retention, so the answer was shown once and not stored."}
        </p>
      ) : run.status === "pending" ? (
        <p className="muted">
          The provider hasn’t confirmed this run yet. Your budget is held until
          it does; it won’t be sent again automatically.
        </p>
      ) : (
        <p className="error-text">
          {(run.error && errorLabel[run.error]) ||
            `The run didn’t finish (${sentence(run.error || "failed")}).`}
        </p>
      )}
      <div className="result-foot">
        {run.output && (
          <Button
            kind="secondary"
            onClick={() => action.run(() => copy(run.output!, "Result"))}
          >
            <Copy size={14} />
            Copy result
          </Button>
        )}
        {run.receiptId && (
          <span className="receipt-chip">
            Signed receipt <code>{shortId(run.receiptId)}</code>
            <button
              className="icon-button"
              aria-label="Copy receipt ID"
              title="Copy receipt ID"
              onClick={() =>
                action.run(() => copy(run.receiptId!, "Receipt ID"))
              }
            >
              <Copy size={13} />
            </button>
          </span>
        )}
        {run.receiptId && (
          <button className="link" onClick={openLedger}>
            View in Ledger <ArrowRight size={13} />
          </button>
        )}
      </div>
      {run.receipt && <JsonDetails label="Signed receipt" value={run.receipt} />}
    </Panel>
  );
}

function Editor({
  playbook,
  available,
  maxRequestUsd,
  close,
  saved,
}: {
  playbook: Playbook | null;
  available: { id: string; name: string; maxTokens: number }[];
  maxRequestUsd: string;
  close: () => void;
  saved: (p: Playbook) => Promise<void>;
}) {
  const { office } = useOffice(),
    action = useAction();
  const [name, setName] = useState(playbook?.name || ""),
    [description, setDescription] = useState(playbook?.description || ""),
    [template, setTemplate] = useState(
      playbook?.template ||
        "Rewrite the text below so it is clear and friendly.\n\n{{text}}",
    ),
    [fields, setFields] = useState<Record<string, PlaybookField>>(() =>
      Object.fromEntries(
        (
          playbook?.fields || [
            { name: "text", label: "Text to rewrite", multiline: true },
          ]
        ).map((f) => [f.name, f]),
      ),
    ),
    [model, setModel] = useState(playbook?.model || available[0]?.id || ""),
    [maxTokens, setMaxTokens] = useState(playbook?.maxTokens || 1024),
    [price, setPrice] = useState(playbook?.maxPriceUsd || "");
  const used = fieldNames(template),
    malformed =
      template.replace(PLACEHOLDER, "").includes("{{") ||
      template.replace(PLACEHOLDER, "").includes("}}"),
    list = used.map(
      (n) =>
        fields[n] || {
          name: n,
          label: sentence(n.replace(/_/g, " ")),
          multiline: false,
        },
    ),
    guard = checkGuards(name, description, template),
    models = available.some((m) => m.id === model)
      ? available
      : model
        ? [...available, { id: model, name: `${model} (not allowed now)`, maxTokens: 8192 }]
        : available;
  const body = () => ({
    name,
    description,
    template,
    fields: list,
    model,
    maxTokens,
    maxPriceUsd: price.trim(),
  });
  async function suggest() {
    const { maxPriceUsd: _, ...rest } = body();
    const r = await api.office(office.id, "/playbooks/suggest-limit", rest);
    setPrice(r.suggestedUsd);
  }
  return (
    <Modal
      title={playbook ? "Edit Playbook" : "New Playbook"}
      close={close}
    >
      <form
        className="playbook-editor"
        onSubmit={submit(() =>
          action.run(async () => {
            if (guard) throw new Error(guard.message);
            const p: Playbook = await api.office(
              office.id,
              playbook ? `/playbooks/${playbook.id}` : "/playbooks",
              body(),
            );
            await saved(p);
          }),
        )}
      >
        <Field label="Name">
          <input
            required
            maxLength={80}
            value={name}
            placeholder="Polish a message"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Short description" help="Tells people when to use it.">
          <input
            maxLength={280}
            value={description}
            placeholder="Make a rough message clear and friendly."
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field
          label="Instructions for the AI"
          help="Write {{field_name}} wherever the person running it fills something in. Use lowercase letters, numbers and underscores."
        >
          <textarea
            required
            rows={6}
            maxLength={20000}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          />
        </Field>
        {malformed && (
          <p className="error-text">
            Close every field with double braces, like {"{{team_name}}"}.
          </p>
        )}
        {list.length > 0 && (
          <fieldset className="field-list">
            <legend>Fill-in fields</legend>
            {list.map((f) => (
              <div className="field-row" key={f.name}>
                <code>{`{{${f.name}}}`}</code>
                <input
                  aria-label={`Label for ${f.name}`}
                  required
                  maxLength={80}
                  value={f.label}
                  onChange={(e) =>
                    setFields({
                      ...fields,
                      [f.name]: { ...f, label: e.target.value },
                    })
                  }
                />
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={f.multiline}
                    onChange={(e) =>
                      setFields({
                        ...fields,
                        [f.name]: { ...f, multiline: e.target.checked },
                      })
                    }
                  />
                  Long text
                </label>
              </div>
            ))}
          </fieldset>
        )}
        <div className="form-grid">
          <Field label="AI model">
            <select
              required
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {!models.length && <option value="">No models available</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Answer length">
            <select
              value={maxTokens}
              onChange={(e) => setMaxTokens(Number(e.target.value))}
            >
              {LENGTHS.some((l) => l.tokens === maxTokens) ? null : (
                <option value={maxTokens}>{maxTokens} tokens</option>
              )}
              {LENGTHS.map((l) => (
                <option key={l.tokens} value={l.tokens}>
                  {l.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field
          label="Price limit per run · USDG"
          help={`A run that could cost more is stopped before anything is sent. This Office allows up to ${usd(maxRequestUsd)} USDG per request.`}
        >
          <div className="price-row">
            <input
              required
              inputMode="decimal"
              pattern="\d{1,3}(\.\d{1,6})?"
              placeholder="0.25"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
            <Button
              type="button"
              kind="secondary"
              busy={action.busy}
              disabled={!model || malformed || !template.trim()}
              onClick={() => action.run(suggest)}
            >
              <Wand2 size={14} />
              Suggest
            </Button>
          </div>
        </Field>
        {guard && (
          <div className="guard-message" role="alert">
            <ShieldCheck size={14} />
            {guard.message}
          </div>
        )}
        <Feedback action={action} />
        <div className="actions">
          <Button
            type="submit"
            busy={action.busy}
            disabled={!model || malformed || !!guard}
          >
            {playbook ? "Save changes" : "Create Playbook"}
          </Button>
          <Button type="button" kind="ghost" onClick={close}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
