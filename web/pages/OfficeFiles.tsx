import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle,
  ArrowUp,
  Check,
  Clock3,
  FileBraces,
  FileSpreadsheet,
  FileText,
  FolderLock,
  MessageSquareText,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useOffice } from "../App";
import { api, date, money, ChanceryError, type Quote } from "../api";
import { checkGuards } from "../../shared/guards";
import { Button, Empty, Feedback, Field, Modal, PageTitle, submit, useAction } from "../ui";
import { Pill, SidePanel, SideItem, SideSection } from "../shell";
import { dayGroup, sentence, shortId, time } from "../data";
import "./OfficeFiles.css";
// Office Files (RELEASED_UPDATES=office_files). Rendered inside the update gate in Updates.tsx.
type FileMeta = {
  id: string;
  name: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedByYou: boolean;
  uploaderRole: string | null;
  createdAt: string;
  updatedAt: string;
};
type Listing = {
  files: FileMeta[];
  usage: { files: number; bytes: number };
  limits: {
    fileBytes: number;
    files: number;
    officeBytes: number;
    selected: number;
    questionCharacters: number;
  };
  types: string[];
  canEdit: boolean;
};
type Cited = { id: string; name: string };
type Answer = {
  question: string;
  answer: string | null;
  files: Cited[];
  model: string;
  chargedUsd: string | null;
  receiptId: string | null;
  createdAt?: string;
  who?: string;
  historyId?: string | null;
  saved: boolean;
};
type Asking = {
  fileIds: string[];
  question: string;
  model: string;
  maxTokens: number;
  lane: string;
};
const LENGTHS = [
  { label: "Short answer", tokens: 500 },
  { label: "Normal answer", tokens: 1200 },
  { label: "Detailed answer", tokens: 3000 },
];
// Leave room for the instructions and question inside the 240,000-character request limit.
const PROMPT_BUDGET = 230000;
function size(bytes: number) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
const typeOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");
function FileIcon({ name, size: px = 15 }: { name: string; size?: number }) {
  const type = typeOf(name);
  if (type === "csv" || type === "tsv") return <FileSpreadsheet size={px} />;
  if (["json", "jsonl", "yaml", "yml", "toml", "xml", "ini"].includes(type)) return <FileBraces size={px} />;
  return <FileText size={px} />;
}
const who = (role: string | null, you: boolean) =>
  you ? "You" : role ? sentence(role) : "Former member";
/** Turn [file name] citations into links that open the cited file. */
function linkCitations(text: string, files: Cited[]) {
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  return text.replace(/\[([^[\]\n]{1,120})\](?!\()/g, (match, name: string) => {
    const file = byName.get(name.trim().toLowerCase());
    if (!file) return match;
    const label = file.name.replace(/([\\`*_{}()#+\-.!|<>~])/g, "\\$1");
    return `[\\[${label}\\]](#office-file/${file.id})`;
  });
}
function cited(text: string, files: Cited[]) {
  const lower = text.toLowerCase();
  return files.filter((f) => lower.includes(`[${f.name.toLowerCase()}]`));
}
/** Small CSV reader for previews: quoted fields, escaped quotes, commas or tabs. */
function parseTable(text: string, delimiter: string, limit = 200) {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length && rows.length < limit; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && !field) quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if ((field || row.length) && rows.length < limit) rows.push([...row, field]);
  return rows;
}
function Preview({ name, content }: { name: string; content: string }) {
  const type = typeOf(name),
    [plain, setPlain] = useState(false);
  const formatted = useMemo(() => {
    if (type === "md" || type === "markdown")
      return (
        <div className="markdown">
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
            {content}
          </Markdown>
        </div>
      );
    if (type === "csv" || type === "tsv") {
      const rows = parseTable(content, type === "tsv" ? "\t" : ","),
        total = content.split("\n").filter(Boolean).length;
      if (!rows.length) return null;
      return (
        <>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  {rows[0].map((h, i) => (
                    <th key={i}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(1).map((r, i) => (
                  <tr key={i}>
                    {r.map((c, j) => (
                      <td key={j}>{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > rows.length && (
            <p className="of-preview-note">
              Showing the first {rows.length} rows. Switch to plain text to see everything.
            </p>
          )}
        </>
      );
    }
    if (type === "json")
      try {
        return <pre>{JSON.stringify(JSON.parse(content), null, 2)}</pre>;
      } catch {
        return null;
      }
    return null;
  }, [content, type]);
  return (
    <div className="of-preview">
      {formatted && (
        <div className="of-segment" role="group" aria-label="Preview style">
          <button className={!plain ? "active" : ""} onClick={() => setPlain(false)}>
            Formatted
          </button>
          <button className={plain ? "active" : ""} onClick={() => setPlain(true)}>
            Plain text
          </button>
        </div>
      )}
      <div className="of-preview-body">{formatted && !plain ? formatted : <pre>{content}</pre>}</div>
    </div>
  );
}
export function OfficeFiles() {
  const { office, models, navigate } = useOffice(),
    action = useAction(),
    upload = useAction(),
    asking = useAction();
  const [listing, setListing] = useState<Listing | null>(null),
    [history, setHistory] = useState<any[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [question, setQuestion] = useState(""),
    [model, setModel] = useState(""),
    [length, setLength] = useState(1),
    [prepared, setPrepared] = useState<{ quote: Quote; payload: Asking } | null>(null),
    [pending, setPending] = useState<{ payload: Asking & { id: string; quoteId: string } } | null>(null),
    [answer, setAnswer] = useState<Answer | null>(null),
    [open, setOpen] = useState<(FileMeta & { content: string }) | null>(null),
    [renaming, setRenaming] = useState(""),
    [dragging, setDragging] = useState(false),
    [now, setNow] = useState(Date.now());
  const picker = useRef<HTMLInputElement>(null),
    answerRef = useRef<HTMLDivElement>(null);
  const guest = office.role === "guest",
    canEdit = !!listing?.canEdit,
    files = listing?.files || [],
    limits = listing?.limits;
  const available = models.filter(
    (m) =>
      (!office.policy.allowedModels.length || office.policy.allowedModels.includes(m.id)) &&
      m.lanes.some((l) => office.policy.allowedLanes.includes(l)),
  );
  const chosen = available.find((m) => m.id === model) || available[0],
    lanes = (chosen?.lanes || ["standard"]).filter((l) => office.policy.allowedLanes.includes(l)),
    lane = lanes.includes("standard") ? "standard" : lanes[0] || "standard",
    maxTokens = Math.min(LENGTHS[length].tokens, chosen?.maxTokens || 8192);
  const ready =
    office.status === "active" && office.seatStatus === "active" && office.moduleEnabled && !guest;
  const guard = checkGuards(question),
    chosenFiles = selected
      .map((id) => files.find((f) => f.id === id))
      .filter((f): f is FileMeta => !!f),
    selectedBytes = chosenFiles.reduce((n, f) => n + f.sizeBytes, 0),
    tooMuch = selectedBytes > PROMPT_BUDGET;
  async function load() {
    const [list, asked] = await Promise.all([
      api.office(office.id, "/files") as Promise<Listing>,
      api.office(office.id, "/file-questions"),
    ]);
    setListing(list);
    setHistory(asked);
    setSelected((s) => s.filter((id) => list.files.some((f) => f.id === id)));
  }
  useEffect(() => {
    if (!guest) void action.run(load);
  }, [office.id]);
  useEffect(() => {
    if (!prepared) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [prepared]);
  useEffect(() => {
    if (answer) answerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [answer?.historyId, answer?.question]);
  async function add(list: FileList | File[]) {
    if (!limits) return;
    const accepted: string[] = [],
      problems: string[] = [];
    for (const file of Array.from(list)) {
      const type = typeOf(file.name);
      if (!listing?.types.includes(type)) {
        problems.push(`${file.name}: Text, Markdown, CSV and JSON for now.`);
        continue;
      }
      if (file.size > limits.fileBytes) {
        problems.push(`${file.name}: files can be up to ${size(limits.fileBytes)} (this one is ${size(file.size)}).`);
        continue;
      }
      const content = await file.text(),
        found = checkGuards(file.name, content);
      if (found) {
        problems.push(
          `${file.name}: this looks like it contains a ${found.kind === "seed" ? "seed phrase" : found.kind === "api_key" ? "API key" : "private key"}. Remove it before uploading.`,
        );
        continue;
      }
      try {
        await api.office(office.id, "/files", { name: file.name, content });
        accepted.push(file.name);
      } catch (error) {
        problems.push(`${file.name}: ${error instanceof Error ? error.message : "could not be added."}`);
      }
    }
    await load();
    if (accepted.length)
      upload.setNotice(
        accepted.length === 1 ? `Added ${accepted[0]}. It’s encrypted and ready to ask about.` : `Added ${accepted.length} files. They’re encrypted and ready to ask about.`,
      );
    if (problems.length) throw new Error(problems.join(" "));
  }
  function drop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (!canEdit || upload.busy) return;
    if (e.dataTransfer.files.length) void upload.run(() => add(e.dataTransfer.files));
  }
  async function preview(id: string) {
    const file = files.find((f) => f.id === id);
    if (!file) {
      action.setError("That file has been deleted from the Office.");
      return;
    }
    const full = await api.office(office.id, `/files/${id}`);
    setRenaming(full.name);
    setOpen(full);
  }
  async function rename() {
    if (!open) return;
    const updated = await api.office(office.id, `/files/${open.id}/rename`, { name: renaming.trim() });
    setOpen({ ...open, ...updated });
    await load();
    action.setNotice(`Renamed to ${updated.name}.`);
  }
  async function remove(file: FileMeta) {
    if (!window.confirm(`Delete ${file.name}? Your team won’t be able to ask about it anymore.`)) return;
    await api.request(`/offices/${office.id}/files/${file.id}`, undefined, "DELETE");
    setOpen(null);
    await load();
    action.setNotice(`Deleted ${file.name}. Earlier answers stay in the history.`);
  }
  function toggle(id: string) {
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : limits && s.length >= limits.selected ? s : [...s, id],
    );
  }
  async function quote() {
    if (guard) throw new Error(guard.message);
    if (!chosen) throw new Error("No AI model is available. Refresh the Office and try again.");
    if (!selected.length) throw new Error("Select at least one file to ask about.");
    const payload: Asking = { fileIds: selected, question: question.trim(), model: chosen.id, maxTokens, lane };
    const q = await api.office(office.id, "/file-questions/quote", payload);
    setPrepared({ quote: q.quote, payload });
    setNow(Date.now());
  }
  function show(result: any, payload: Asking) {
    if (result.status === "complete") {
      setPending(null);
      setAnswer({
        question: payload.question,
        answer: result.content,
        files: result.files,
        model: payload.model,
        chargedUsd: result.chargedUsd,
        receiptId: result.receipt?.payload?.id || null,
        createdAt: new Date().toISOString(),
        who: "You",
        historyId: result.historyId,
        saved: !!result.historyId,
      });
      setQuestion("");
    } else if (result.status === "refused") {
      setPending(null);
      asking.setError(
        `The AI provider refused this request${result.error ? ` (${result.error})` : ""}. Nothing was charged.`,
      );
    }
  }
  async function send() {
    if (!prepared) return;
    if (Date.now() >= Date.parse(prepared.quote.expiresAt))
      throw new Error("This price expired. Review the price again.");
    const payload = { ...prepared.payload, id: crypto.randomUUID(), quoteId: prepared.quote.id };
    setPrepared(null);
    setPending({ payload });
    try {
      show(await api.office(office.id, "/file-questions", payload), payload);
    } catch (error) {
      if (error instanceof ChanceryError && error.status >= 400 && error.status < 500) setPending(null);
      throw error;
    } finally {
      api.office(office.id, "/file-questions").then(setHistory, () => {});
    }
  }
  /** Re-sending the same request ID never runs it twice; it returns the recorded outcome. */
  async function check() {
    if (!pending) return;
    show(await api.office(office.id, "/file-questions", pending.payload), pending.payload);
    setHistory(await api.office(office.id, "/file-questions"));
  }
  async function forget(id: string) {
    await api.request(`/offices/${office.id}/file-questions/${id}`, undefined, "DELETE");
    if (answer?.historyId === id) setAnswer(null);
    setHistory(await api.office(office.id, "/file-questions"));
  }
  const secondsLeft = prepared ? Math.max(0, Math.ceil((Date.parse(prepared.quote.expiresAt) - now) / 1000)) : 0;
  if (guest)
    return (
      <Empty icon={<FolderLock />} title="Office Files are for members.">
        Guest access covers your invited Rooms. Ask an Officer if you need to read the Office’s files.
      </Empty>
    );
  const panel = (
    <SidePanel
      title="Office Files"
      action={
        <button
          className="icon-button"
          aria-label="Refresh files"
          title="Refresh"
          disabled={action.busy}
          onClick={() => action.run(load)}
        >
          <RefreshCw size={15} />
        </button>
      }
    >
      {canEdit && (
        <button className="side-new" disabled={upload.busy} onClick={() => picker.current?.click()}>
          <Upload size={15} />
          Add files
        </button>
      )}
      <SideSection label="Recent questions">
        {history.length ? (
          history.map((h) => (
            <div className={`side-row ${answer?.historyId === h.id ? "active" : ""}`} key={h.id}>
              <SideItem
                active={answer?.historyId === h.id}
                leading={<MessageSquareText size={15} />}
                title={h.question}
                meta={`${who(h.askerRole, h.askedByYou)} · ${dayGroup(h.createdAt)} ${time(h.createdAt)}`}
                onClick={() =>
                  setAnswer({
                    question: h.question,
                    answer: h.answer,
                    files: h.files,
                    model: h.model,
                    chargedUsd: h.chargedUsd,
                    receiptId: h.receiptId,
                    createdAt: h.createdAt,
                    who: who(h.askerRole, h.askedByYou),
                    historyId: h.id,
                    saved: true,
                  })
                }
              />
              {(h.askedByYou || canEdit) && (
                <button
                  className="icon-button side-row-action"
                  aria-label={`Remove question: ${h.question}`}
                  title="Remove from history"
                  disabled={action.busy}
                  onClick={() => action.run(() => forget(h.id))}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))
        ) : (
          <p className="side-note">Questions your team asks appear here so anyone can revisit the answer.</p>
        )}
      </SideSection>
      {listing && (
        <SideSection label="Storage">
          <p className="side-note">
            {listing.usage.files} of {listing.limits.files} files · {size(listing.usage.bytes)} of{" "}
            {size(listing.limits.officeBytes)} used. Names and contents are encrypted at rest.
          </p>
        </SideSection>
      )}
    </SidePanel>
  );
  return (
    <div
      className={`office-files ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={drop}
    >
      {panel}
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        accept={(listing?.types || []).map((t) => `.${t}`).join(",")}
        onChange={(e) => {
          const chosenList = Array.from(e.target.files || []);
          e.target.value = "";
          if (chosenList.length) void upload.run(() => add(chosenList));
        }}
      />
      <PageTitle eyebrow="Office Files" title="AI that knows your docs">
        Keep encrypted reference files your team can ask AI about. Answers cite the files they used.
      </PageTitle>
      <Feedback action={action} />
      {canEdit && (
        <div
          className={`of-drop ${dragging ? "over" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => !upload.busy && picker.current?.click()}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && !upload.busy) {
              e.preventDefault();
              picker.current?.click();
            }
          }}
        >
          <span className="of-drop-icon">
            {upload.busy ? <RefreshCw size={18} className="spin" /> : <Upload size={18} />}
          </span>
          <div>
            <strong>{upload.busy ? "Encrypting and adding…" : "Drop files here or choose files"}</strong>
            <span>
              Text, Markdown, CSV and JSON for now · up to {size(limits?.fileBytes || 204800)} each. PDF and Word files
              aren’t supported yet.
            </span>
          </div>
        </div>
      )}
      <Feedback action={upload} />
      <div className="table-card of-files">
        {files.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th className="of-check">
                    <input
                      type="checkbox"
                      aria-label="Select all files"
                      disabled={!!prepared || !!pending}
                      checked={selected.length > 0 && selected.length === Math.min(files.length, limits?.selected || 20)}
                      onChange={(e) =>
                        setSelected(e.target.checked ? files.slice(0, limits?.selected || 20).map((f) => f.id) : [])
                      }
                    />
                  </th>
                  <th>Name</th>
                  <th className="num">Size</th>
                  <th>Added by</th>
                  <th>Added</th>
                  <th className="end" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.id} className={selected.includes(f.id) ? "selected" : ""}>
                    <td className="of-check">
                      <input
                        type="checkbox"
                        aria-label={`Select ${f.name}`}
                        checked={selected.includes(f.id)}
                        disabled={!!prepared || !!pending}
                        onChange={() => toggle(f.id)}
                      />
                    </td>
                    <td>
                      <button className="of-name" onClick={() => action.run(() => preview(f.id))}>
                        <FileIcon name={f.name} />
                        <span>{f.name}</span>
                      </button>
                    </td>
                    <td className="num muted nowrap">{size(f.sizeBytes)}</td>
                    <td className="nowrap">{who(f.uploaderRole, f.uploadedByYou)}</td>
                    <td className="nowrap muted">{date(f.createdAt)}</td>
                    <td className="end nowrap">
                      <button className="link" onClick={() => action.run(() => preview(f.id))}>
                        Open
                      </button>
                      {canEdit && (
                        <button
                          className="icon-button of-row-action"
                          aria-label={`Delete ${f.name}`}
                          title="Delete"
                          onClick={() => action.run(() => remove(f))}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={<FolderLock />} title={listing ? "No files yet." : "Loading files…"}>
            {canEdit
              ? "Add a handbook, a price list or meeting notes. Then ask questions and get answers that point to the right file."
              : "An Officer or Principal can add reference files. Once they do, you can ask questions about them here."}
          </Empty>
        )}
        {files.length > 0 && (
          <div className="table-foot">
            <span className="muted">
              {selected.length ? `${selected.length} selected · ${size(selectedBytes)} of text` : "Tick the files you want to ask about."}
            </span>
            <span className="muted">Encrypted at rest</span>
          </div>
        )}
      </div>
      {files.length > 0 && (
        <section className="of-ask" aria-label="Ask your files">
          <div className="of-ask-head">
            <h2>Ask your files</h2>
            <div className="of-chips">
              {chosenFiles.length ? (
                chosenFiles.map((f) => (
                  <span className="of-chip" key={f.id}>
                    <FileIcon name={f.name} size={13} />
                    {f.name}
                    <button
                      aria-label={`Deselect ${f.name}`}
                      disabled={!!prepared || !!pending}
                      onClick={() => toggle(f.id)}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))
              ) : (
                <span className="muted">No files selected yet.</span>
              )}
            </div>
          </div>
          {tooMuch && (
            <div className="notice warning">
              <AlertCircle size={16} />
              <span>That’s a lot of text for one question. Deselect a large file or two before reviewing the price.</span>
            </div>
          )}
          {pending && (
            <div className="notice warning">
              <Clock3 size={16} />
              <span>
                {asking.busy
                  ? "Reading your files and writing an answer…"
                  : "We couldn’t confirm how this question finished. Check its status before asking again; it won’t be sent twice."}
              </span>
              {!asking.busy && (
                <Button kind="ghost" onClick={() => asking.run(check)}>
                  <RefreshCw size={14} />
                  Check status
                </Button>
              )}
            </div>
          )}
          <Feedback action={asking} />
          <div className={`composer ${guard ? "blocked" : ""}`}>
            <textarea
              aria-label="Question about the selected files"
              placeholder={ready ? "What would you like to know? For example: When are expense reports due?" : "Approve your Office and seat to ask questions."}
              value={question}
              maxLength={limits?.questionCharacters || 4000}
              rows={2}
              disabled={!ready || !!prepared || !!pending}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (question.trim() && selected.length && !guard && !asking.busy && !prepared && !pending)
                    void asking.run(quote);
                }
              }}
            />
            <div className="composer-controls">
              <select
                aria-label="AI model"
                value={chosen?.id || ""}
                disabled={!!prepared || !!pending}
                onChange={(e) => setModel(e.target.value)}
              >
                {!available.length && <option value="">Models unavailable</option>}
                {available.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Answer length"
                value={length}
                disabled={!!prepared || !!pending}
                onChange={(e) => setLength(Number(e.target.value))}
              >
                {LENGTHS.map((l, i) => (
                  <option key={l.label} value={i}>
                    {l.label}
                  </option>
                ))}
              </select>
              <span className="lane-label">
                <ShieldCheck size={14} />
                {lane === "zero_retention" ? "Zero retention · answer not saved" : "Standard processing"}
              </span>
              <span className="composer-budget" />
              <Button
                busy={asking.busy && !prepared && !pending}
                disabled={!ready || !question.trim() || !selected.length || !!guard || !chosen || !!prepared || !!pending}
                onClick={() => asking.run(quote)}
              >
                Review price
                <ArrowUp size={15} />
              </Button>
            </div>
          </div>
          {prepared && (
            <div className="quote-strip" role="dialog" aria-label="Review price">
              <div>
                <small>Maximum charge</small>
                <strong>
                  {money(prepared.quote.maximumUsd, 6)} <span>USDG</span>
                </strong>
              </div>
              <div className="quote-meta">
                {prepared.payload.fileIds.length} file{prepared.payload.fileIds.length === 1 ? "" : "s"} · {chosen?.name} ·{" "}
                {secondsLeft > 0 ? `valid ${secondsLeft}s` : "expired"}
              </div>
              <Button kind="ghost" onClick={() => setPrepared(null)}>
                Cancel
              </Button>
              <Button busy={asking.busy} disabled={secondsLeft <= 0} onClick={() => asking.run(send)}>
                Approve & ask
                <ArrowUp size={15} />
              </Button>
            </div>
          )}
          {guard ? (
            <div className="guard-message" role="alert">
              <ShieldCheck size={14} />
              {guard.message}
            </div>
          ) : (
            <p className="composer-note">
              You approve the maximum price before anything is sent. You only pay for what the answer uses, and a
              signed receipt goes to the Ledger.
            </p>
          )}
        </section>
      )}
      {answer && (
        <article className="of-answer" ref={answerRef} aria-label="Answer">
          <header>
            <div>
              <span className="eyebrow">
                {answer.who || "You"} asked
                {answer.createdAt ? ` · ${date(answer.createdAt)}` : ""}
              </span>
              <h2>{answer.question}</h2>
            </div>
            <button className="icon-button" aria-label="Close answer" onClick={() => setAnswer(null)}>
              <X size={16} />
            </button>
          </header>
          <div className="markdown">
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                img: () => null,
                a: ({ children, href }) =>
                  href?.startsWith("#office-file/") ? (
                    <button
                      type="button"
                      className="of-cite"
                      title="Open this file"
                      onClick={() => action.run(() => preview(href.slice("#office-file/".length)))}
                    >
                      {children}
                    </button>
                  ) : (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  ),
              }}
            >
              {linkCitations(answer.answer || "", answer.files)}
            </Markdown>
          </div>
          <div className="of-sources">
            <span className="muted">{cited(answer.answer || "", answer.files).length ? "Sources" : "Files given"}</span>
            {(cited(answer.answer || "", answer.files).length ? cited(answer.answer || "", answer.files) : answer.files).map(
              (f) => (
                <button key={f.id} className="of-chip of-chip-link" onClick={() => action.run(() => preview(f.id))}>
                  <FileIcon name={f.name} size={13} />
                  {f.name}
                </button>
              ),
            )}
          </div>
          <footer>
            {answer.chargedUsd !== null && (
              <span className="receipt-chip">
                {money(answer.chargedUsd, 6)} USDG
                <Check size={13} />
              </span>
            )}
            {answer.receiptId && (
              <span className="muted">
                Receipt <code title={answer.receiptId}>{shortId(answer.receiptId)}</code>
              </span>
            )}
            <span className="muted">{models.find((m) => m.id === answer.model)?.name || answer.model}</span>
            {!answer.saved && <Pill>Not saved to history</Pill>}
            <span className="of-spacer" />
            <button
              className="link"
              onClick={() =>
                action.run(async () => {
                  await navigator.clipboard.writeText(answer.answer || "");
                  action.setNotice("Answer copied.");
                })
              }
            >
              Copy
            </button>
            {answer.receiptId && (
              <button className="link" onClick={() => navigate("ledger")}>
                View in Ledger
              </button>
            )}
          </footer>
        </article>
      )}
      {open && (
        <Modal title={open.name} close={() => setOpen(null)}>
          <div className="of-modal">
            <p className="of-meta">
              <FileIcon name={open.name} size={14} />
              {size(open.sizeBytes)} · added by{" "}
              {open.uploadedByYou ? "you" : who(open.uploaderRole, false).toLowerCase()} · {date(open.createdAt)}
            </p>
            <Preview name={open.name} content={open.content} />
            {canEdit && (
              <form className="of-rename" onSubmit={submit(() => action.run(rename))}>
                <Field label="File name" help="Answers cite files by name, so keep it short and clear.">
                  <input value={renaming} maxLength={120} required onChange={(e) => setRenaming(e.target.value)} />
                </Field>
                <div className="of-modal-actions">
                  <Button type="submit" kind="secondary" busy={action.busy} disabled={!renaming.trim() || renaming.trim() === open.name}>
                    <Pencil size={14} />
                    Rename
                  </Button>
                  <Button type="button" kind="danger" busy={action.busy} onClick={() => action.run(() => remove(open))}>
                    <Trash2 size={14} />
                    Delete
                  </Button>
                </div>
              </form>
            )}
            <Feedback action={action} />
          </div>
        </Modal>
      )}
    </div>
  );
}
