import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Clock3,
  FileText,
  History,
  LockKeyhole,
  MessageSquare,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useOffice } from "../App";
import {
  api,
  date,
  money,
  errorText,
  type Message,
  type Conversation,
  type Quote,
  ChanceryError,
} from "../api";
import { checkGuards } from "../../shared/guards";
import {
  Badge,
  Button,
  Empty,
  Feedback,
  Field,
  Modal,
  PageTitle,
  useAction,
} from "../ui";
export function Chat() {
  const { office, account, models, navigate } = useOffice(),
    action = useAction();
  const available = models.filter(
    (m) =>
      (!office.policy.allowedModels.length ||
        office.policy.allowedModels.includes(m.id)) &&
      m.lanes.some((l) => office.policy.allowedLanes.includes(l)),
  );
  const [model, setModel] = useState(""),
    [lane, setLane] = useState("standard"),
    [maxTokens, setMaxTokens] = useState(1024),
    [prompt, setPrompt] = useState(""),
    [messages, setMessages] = useState<Message[]>([]),
    [conversations, setConversations] = useState<Conversation[]>([]),
    [conversation, setConversation] = useState<Conversation | null>(null),
    [ephemeral, setEphemeral] = useState(false),
    [history, setHistory] = useState(false);
  const [prepared, setPrepared] = useState<{
      quote: Quote;
      chat: any;
      requestId: string;
    } | null>(null),
    [result, setResult] = useState<any>(null),
    [now, setNow] = useState(Date.now()),
    [pending, setPending] = useState<{
      id: string;
      conversationId?: string;
    } | null>(() => {
      try {
        return JSON.parse(
          sessionStorage.getItem(
            `chancery:pending:${account.id}:${office.id}`,
          ) || "null",
        );
      } catch {
        return null;
      }
    });
  const tail = useRef<HTMLDivElement>(null),
    inFlight = useRef(false);
  const chosen = available.find((m) => m.id === model) || available[0];
  useEffect(() => {
    if (!chosen) return;
    if (!model || !available.some((m) => m.id === model)) setModel(chosen.id);
    const lanes = chosen.lanes.filter((l) =>
      office.policy.allowedLanes.includes(l),
    );
    if (!lanes.includes(lane)) setLane(lanes[0]);
    setMaxTokens((n) => Math.min(n, chosen.maxTokens));
  }, [
    models,
    model,
    office.policy.allowedModels.join(","),
    office.policy.allowedLanes.join(","),
  ]);
  useEffect(() => {
    if (office.status === "active" && office.role !== "guest")
      void action.run(async () =>
        setConversations(await api.office(office.id, "/conversations")),
      );
  }, [office.id, office.status]);
  useEffect(() => {
    tail.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, result?.status]);
  useEffect(() => {
    if (!prepared) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [prepared]);
  const guard = checkGuards(prompt),
    allowed =
      office.status === "active" &&
      office.seatStatus === "active" &&
      office.moduleEnabled &&
      office.role !== "guest";
  function savePending(value: { id: string; conversationId?: string } | null) {
    setPending(value);
    try {
      if (value)
        sessionStorage.setItem(
          `chancery:pending:${account.id}:${office.id}`,
          JSON.stringify(value),
        );
      else
        sessionStorage.removeItem(
          `chancery:pending:${account.id}:${office.id}`,
        );
    } catch {}
  }
  async function quote() {
    if (guard) throw new Error(guard.message);
    if (!chosen)
      throw new Error(
        "The model catalog is unavailable. Refresh the Office and try again.",
      );
    if (!prompt.trim()) return;
    let current = conversation;
    if (!current) {
      current = await api.office(office.id, "/conversations", {
        title:
          ephemeral || lane === "zero_retention"
            ? "Temporary conversation"
            : prompt.trim().slice(0, 80),
        ephemeral: ephemeral || lane === "zero_retention",
      });
      setConversation(current);
      setConversations(await api.office(office.id, "/conversations"));
    }
    const chat = {
      model: chosen.id,
      messages: [
        ...messages.map(({ role, content }) => ({ role, content })),
        { role: "user", content: prompt.trim() },
      ],
      maxTokens,
      lane,
      conversationId: current!.id,
    };
    const q = await api.office(office.id, "/quotes", chat);
    setPrepared({ quote: q, chat, requestId: crypto.randomUUID() });
    setNow(Date.now());
  }
  function receive(response: any, submittedMessages?: Message[]) {
    setResult(response);
    if (response.status === "complete") {
      savePending(null);
      if (response.content) {
        setMessages((previous) => {
          const base = submittedMessages || previous;
          const last = base[base.length - 1];
          return last?.role === "assistant" && last.content === response.content
            ? base
            : [...base, { role: "assistant", content: response.content }];
        });
      }
    } else if (response.status === "failed") savePending(null);
  }
  async function send() {
    if (!prepared || inFlight.current) return;
    if (Date.now() >= Date.parse(prepared.quote.expiresAt))
      throw new Error(
        "This quote expired. Close it and request a fresh quote.",
      );
    inFlight.current = true;
    const submission = prepared;
    savePending({
      id: submission.requestId,
      conversationId: submission.chat.conversationId,
    });
    setMessages(submission.chat.messages);
    setPrompt("");
    setPrepared(null);
    setResult({ status: "pending", id: submission.requestId });
    try {
      receive(
        await api.office(office.id, "/chat", {
          id: submission.requestId,
          quoteId: submission.quote.id,
          chat: submission.chat,
        }),
        submission.chat.messages,
      );
    } catch (error) {
      if (
        error instanceof ChanceryError &&
        ((error.status >= 400 &&
          error.status < 500 &&
          error.code !== "idempotency_conflict") ||
          error.code === "provider_unconfigured")
      ) {
        savePending(null);
        setMessages(submission.chat.messages.slice(0, -1));
        setPrompt(submission.chat.messages.at(-1).content);
        setResult(null);
      } else setResult({ status: "unconfirmed", id: submission.requestId });
      throw error;
    } finally {
      inFlight.current = false;
    }
  }
  async function inspect() {
    if (!pending) return;
    try {
      const response = await api.office(office.id, `/requests/${pending.id}`);
      if (pending.conversationId && response.status === "complete") {
        const c = conversations.find((c) => c.id === pending.conversationId);
        if (c) setConversation(c);
        const stored = await api.office(
          office.id,
          `/conversations/${pending.conversationId}/messages`,
        );
        if (stored.length) setMessages(stored);
      }
      receive(response);
    } catch (error) {
      if (
        error instanceof ChanceryError &&
        error.code === "request_not_found"
      ) {
        action.setNotice(
          "The server has no record of this request yet. No new request has been sent. Check again before starting another.",
        );
        return;
      }
      throw error;
    }
  }
  async function open(c: Conversation) {
    if (pending)
      throw new Error(
        "Resolve the pending request before switching conversations.",
      );
    setMessages(await api.office(office.id, `/conversations/${c.id}/messages`));
    setConversation(c);
    setEphemeral(c.ephemeral);
    setPrompt("");
    setPrepared(null);
    setResult(null);
    setHistory(false);
  }
  if (office.role === "guest")
    return (
      <Empty icon={<LockKeyhole />} title="Your invitation opens a Room.">
        Guest access covers your invited Rooms. Visit Updates to open the
        encrypted Rooms feature.
      </Empty>
    );
  return (
    <div className="chat-page">
      <PageTitle
        eyebrow="YOUR PRIVATE AI WORKSPACE"
        title={conversation?.title || "What are we working on?"}
        actions={
          <>
            <Button kind="secondary" onClick={() => setHistory(true)}>
              <History size={16} />
              History
            </Button>
            <Button
              kind="secondary"
              disabled={!!pending || action.busy}
              onClick={() => {
                setConversation(null);
                setMessages([]);
                setPrompt("");
                setResult(null);
                setPrepared(null);
              }}
            >
              <Plus size={16} />
              New chat
            </Button>
          </>
        }
      />
      <Feedback action={action} />
      {pending && (
        <div className="notice warning">
          <Clock3 size={18} />
          <span>
            {result?.status === "uncertain"
              ? "The provider outcome needs reconciliation. Your reserved budget is held; this request won’t be sent again automatically."
              : "A request is pending or its outcome has not been confirmed. Check its status before sending another."}
          </span>
          <Button
            kind="ghost"
            busy={action.busy}
            onClick={() => action.run(inspect)}
          >
            <RefreshCw size={15} />
            Check status
          </Button>
        </div>
      )}
      <div className={`chat-content ${messages.length ? "has-messages" : ""}`}>
        {messages.length ? (
          <div className="messages">
            {messages.map((m, i) => (
              <article key={m.id || i} className={`message ${m.role}`}>
                <span className="message-avatar">
                  {m.role === "assistant" ? (
                    <img src="/app/brand/mark.svg" alt="Chancery" />
                  ) : (
                    "You"
                  )}
                </span>
                <div>
                  <span className="message-author">
                    {m.role === "assistant" ? "Chancery" : "You"}
                  </span>
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
                      {m.content}
                    </Markdown>
                  </div>
                </div>
              </article>
            ))}
            {result?.status === "complete" && (
              <div className="chat-receipt">
                <Check size={14} /> {money(result.chargedUsd, 6)} USDG · Receipt
                recorded
                <button onClick={() => navigate("ledger")}>
                  View in Ledger →
                </button>
              </div>
            )}
            {result?.status === "failed" && (
              <div className="notice error">
                The request failed.{" "}
                {result.error || "Try a new request when ready."}
              </div>
            )}
            <div ref={tail} />
          </div>
        ) : (
          <div className="chat-intro">
            <div className="chat-mark">
              <img src="/app/brand/mark.svg" alt="" />
            </div>
            <span className="eyebrow">A FRESH PERSPECTIVE</span>
            <h2>
              A little help.
              <br />A place to start.
            </h2>
            <p>
              Bring your questions. Choose your model.
              <br />
              Your Office takes care of the rest.
            </p>
            <div className="suggestions">
              {[
                {
                  icon: FileText,
                  title: "Make it clear",
                  text: "Help me turn these notes into a clear summary.",
                },
                {
                  icon: Sparkles,
                  title: "Think it through",
                  text: "Help me compare the tradeoffs for a decision my team is making.",
                },
                {
                  icon: ShieldCheck,
                  title: "Plan the next step",
                  text: "Help me create a checklist for our next project milestone.",
                },
              ].map(({ icon: Icon, title, text }) => (
                <button key={title} onClick={() => setPrompt(text)}>
                  <Icon size={19} />
                  <strong>{title}</strong>
                  <span>{text}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="composer-wrap">
        <div className={`composer ${guard ? "blocked" : ""}`}>
          <textarea
            aria-label="Message"
            placeholder={
              allowed
                ? "What would you like to work on?"
                : "Approve your Office and seat to start a conversation."
            }
            value={prompt}
            disabled={!allowed || !!pending || action.busy}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={60000}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (!guard && prompt.trim() && !action.busy && !pending)
                  void action.run(quote);
              }
            }}
          />
          <div className="composer-controls">
            <label className="model-select">
              <Sparkles size={15} />
              <select
                aria-label="AI model"
                value={chosen?.id || ""}
                disabled={action.busy || !!pending}
                onChange={(e) => setModel(e.target.value)}
              >
                {!available.length && (
                  <option value="">Models unavailable</option>
                )}
                {available.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <select
              className="lane-select"
              aria-label="Privacy lane"
              value={lane}
              disabled={action.busy || !!pending}
              onChange={(e) => setLane(e.target.value)}
            >
              {(chosen?.lanes || ["standard"])
                .filter((l) => office.policy.allowedLanes.includes(l))
                .map((l) => (
                  <option key={l} value={l}>
                    {l === "standard" ? "Standard" : "Zero retention"}
                  </option>
                ))}
            </select>
            <Button
              className="send-button"
              busy={action.busy}
              disabled={
                !allowed || !prompt.trim() || !!guard || !chosen || !!pending
              }
              onClick={() => action.run(quote)}
            >
              Review price
              <ArrowUp size={17} />
            </Button>
          </div>
        </div>
        {guard ? (
          <div className="guard-message" role="alert">
            <ShieldCheck size={14} />
            {guard.message}
          </div>
        ) : (
          <div className="composer-note">
            <span>
              <ShieldCheck size={13} />
              Guards on ·{" "}
              {lane === "zero_retention"
                ? "Response content is not stored."
                : "Messages are sent to your chosen provider."}
            </span>
            <details>
              <summary>Options</summary>
              <Field label="Maximum output tokens">
                <input
                  type="number"
                  min="1"
                  max={chosen?.maxTokens || 8192}
                  value={maxTokens}
                  onChange={(e) =>
                    setMaxTokens(
                      Math.max(
                        1,
                        Math.min(
                          chosen?.maxTokens || 8192,
                          Number(e.target.value) || 1,
                        ),
                      ),
                    )
                  }
                />
              </Field>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={conversation?.ephemeral ?? ephemeral}
                  disabled={!!conversation}
                  onChange={(e) => setEphemeral(e.target.checked)}
                />
                Don’t save this conversation
              </label>
              <small>Billing receipts are always retained.</small>
            </details>
          </div>
        )}
      </div>
      {prepared && (
        <Modal
          title="A clear price before you send."
          close={() => setPrepared(null)}
        >
          <div className="quote-price">
            <small>MAXIMUM CHARGE</small>
            <strong>
              {money(prepared.quote.maximumUsd, 6)}
              <span>USDG</span>
            </strong>
            <p>
              Includes provider cost and Chancery’s platform fee. You won’t be
              charged more than this amount.
            </p>
          </div>
          <dl className="detail-list">
            <div>
              <dt>Model</dt>
              <dd>{chosen?.name}</dd>
            </div>
            <div>
              <dt>Privacy</dt>
              <dd>
                {lane === "standard"
                  ? "Standard provider processing"
                  : "Operator-verified zero retention"}
              </dd>
            </div>
            <div>
              <dt>Quote valid for</dt>
              <dd>
                {Math.max(
                  0,
                  Math.ceil(
                    (Date.parse(prepared.quote.expiresAt) - now) / 1000,
                  ),
                )}{" "}
                seconds
              </dd>
            </div>
          </dl>
          <Feedback action={action} />
          <Button
            busy={action.busy}
            disabled={now >= Date.parse(prepared.quote.expiresAt)}
            onClick={() => action.run(send)}
          >
            Approve & send
            <ArrowUp size={16} />
          </Button>
        </Modal>
      )}
      {history && (
        <Modal title="Your conversations" close={() => setHistory(false)}>
          {conversations.length ? (
            conversations.map((c) => (
              <div className="history-row" key={c.id}>
                <button onClick={() => action.run(() => open(c))}>
                  <MessageSquare size={17} />
                  <span>
                    {c.title}
                    <small>
                      {c.ephemeral ? "Temporary · " : ""}
                      {date(c.createdAt)}
                    </small>
                  </span>
                </button>
                <button
                  className="icon-button"
                  aria-label={`Delete ${c.title}`}
                  disabled={action.busy || !!pending}
                  onClick={() =>
                    action.run(async () => {
                      await api.request(
                        `/offices/${office.id}/conversations/${c.id}`,
                        undefined,
                        "DELETE",
                      );
                      setConversations(
                        conversations.filter((x) => x.id !== c.id),
                      );
                      if (conversation?.id === c.id) {
                        setConversation(null);
                        setMessages([]);
                        setResult(null);
                      }
                      action.setNotice(
                        "Conversation deleted. Billing receipts are retained.",
                      );
                    })
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))
          ) : (
            <Empty title="Your next idea starts here." icon={<MessageSquare />}>
              Saved conversations will appear here.
            </Empty>
          )}
          <Feedback action={action} />
        </Modal>
      )}
    </div>
  );
}
