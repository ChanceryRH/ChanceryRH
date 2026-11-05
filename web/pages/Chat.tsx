import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Clock3,
  FileText,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Sparkle,
  Sparkles,
  SquarePen,
  Trash2,
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
import { Button, Empty, Feedback, Field, useAction } from "../ui";
import { Pill, SidePanel, SideItem, SideSection, avatarStyle } from "../shell";
import { dayGroup, groupBy, time } from "../data";
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
    [ephemeral, setEphemeral] = useState(false);
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
  }
  useEffect(() => {
    let id: string | null = null;
    try {
      id = sessionStorage.getItem("chancery:open-conversation");
      sessionStorage.removeItem("chancery:open-conversation");
    } catch {}
    if (!id || !conversations.length) return;
    const c = conversations.find((x) => x.id === id);
    if (c && !pending) void action.run(() => open(c));
  }, [conversations.length]);
  function reset() {
    setConversation(null);
    setMessages([]);
    setPrompt("");
    setResult(null);
    setPrepared(null);
  }
  async function remove(c: Conversation) {
    await api.request(
      `/offices/${office.id}/conversations/${c.id}`,
      undefined,
      "DELETE",
    );
    setConversations(conversations.filter((x) => x.id !== c.id));
    if (conversation?.id === c.id) reset();
    action.setNotice("Conversation deleted. Billing receipts are retained.");
  }
  const lanes = (chosen?.lanes || ["standard"]).filter((l) =>
    office.policy.allowedLanes.includes(l),
  );
  const available$ = Math.max(
    0,
    Number(office.capUsd) - Number(office.spentUsd),
  );
  const groups = groupBy(conversations, (c) => dayGroup(c.createdAt));
  const secondsLeft = prepared
    ? Math.max(0, Math.ceil((Date.parse(prepared.quote.expiresAt) - now) / 1000))
    : 0;
  if (office.role === "guest")
    return (
      <Empty icon={<LockKeyhole />} title="Your invitation opens a Room.">
        Guest access covers your invited Rooms. Open Rooms from the rail to
        continue.
      </Empty>
    );
  return (
    <div className="chat-page">
      <SidePanel
        title="Workspace"
      >
        <button
          className="side-new"
          disabled={!!pending || action.busy}
          onClick={reset}
        >
          <SquarePen size={15} />
          New chat
        </button>
        {conversations.length ? (
          [...groups.entries()].map(([label, list]) => (
            <SideSection label={label} key={label}>
              {list.map((c) => (
                <div
                  className={`side-row ${conversation?.id === c.id ? "active" : ""}`}
                  key={c.id}
                >
                  <SideItem
                    active={conversation?.id === c.id}
                    title={c.title}
                    meta={`${c.ephemeral ? "Temporary · " : ""}${time(c.createdAt)}`}
                    onClick={() => action.run(() => open(c))}
                  />
                  <button
                    className="icon-button side-row-action"
                    aria-label={`Delete ${c.title}`}
                    title="Delete conversation"
                    disabled={action.busy || !!pending}
                    onClick={() => action.run(() => remove(c))}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </SideSection>
          ))
        ) : (
          <p className="side-note">Saved conversations appear here.</p>
        )}
      </SidePanel>
      <header className="chat-head">
        <div>
          <h1>{conversation?.title || "New conversation"}</h1>
          <label className="model-pill">
            <select
              aria-label="AI model"
              value={chosen?.id || ""}
              disabled={action.busy || !!pending || !!prepared}
              onChange={(e) => setModel(e.target.value)}
            >
              {!available.length && <option value="">Models unavailable</option>}
              {available.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <ChevronDown size={14} />
            {chosen && (
              <span className="model-price">
                ${Number(chosen.inputUsdPerMillion)} / $
                {Number(chosen.outputUsdPerMillion)} per 1M tokens
              </span>
            )}
          </label>
        </div>
        {conversation?.ephemeral && <Pill>Temporary</Pill>}
      </header>
      <Feedback action={action} />
      {pending && (
        <div className="notice warning">
          <Clock3 size={17} />
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
            <RefreshCw size={14} />
            Check status
          </Button>
        </div>
      )}
      <div className={`chat-content ${messages.length ? "has-messages" : ""}`}>
        {messages.length ? (
          <div className="messages">
            {messages.map((m, i) => {
              const last = i === messages.length - 1;
              return (
                <article key={m.id || i} className={`message ${m.role}`}>
                  <span
                    className={`message-avatar ${m.role !== "assistant" && account.wallet ? "tinted" : ""}`}
                    style={m.role !== "assistant" && account.wallet ? avatarStyle(account.wallet) : undefined}
                  >
                    {m.role === "assistant" ? (
                      <Sparkle size={15} />
                    ) : account.wallet ? (
                      account.wallet.slice(2, 4).toUpperCase()
                    ) : (
                      "You"
                    )}
                  </span>
                  <div className="message-body">
                    <span className="message-author">
                      {m.role === "assistant"
                        ? models.find((x) => x.id === m.model)?.name ||
                          chosen?.name ||
                          "Assistant"
                        : "You"}
                      {m.createdAt && <time>{time(m.createdAt)}</time>}
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
                    {m.role === "assistant" && (
                      <div className="message-foot">
                        {last && result?.status === "complete" && (
                          <span className="receipt-chip">
                            {money(result.chargedUsd, 6)} USDG · receipt
                            <Check size={13} />
                          </span>
                        )}
                        <button
                          onClick={() =>
                            action.run(async () => {
                              await navigator.clipboard.writeText(m.content);
                              action.setNotice("Copied.");
                            })
                          }
                        >
                          Copy
                        </button>
                        {last && result?.status === "complete" && (
                          <button onClick={() => navigate("ledger")}>
                            View receipt
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
            {result?.status === "pending" && (
              <div className="thinking">
                <span />
                <span />
                <span />
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
            <h2>What are we working on?</h2>
            <p>
              Choose a model, write your request, and review the maximum price
              before anything is sent.
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
                  <Icon size={16} />
                  <strong>{title}</strong>
                  <span>{text}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="composer-wrap">
        {prepared && (
          <div className="quote-strip" role="dialog" aria-label="Review price">
            <div>
              <small>Maximum charge</small>
              <strong>
                {money(prepared.quote.maximumUsd, 6)} <span>USDG</span>
              </strong>
            </div>
            <div className="quote-meta">
              {chosen?.name} ·{" "}
              {lane === "standard" ? "Standard processing" : "Zero retention"} ·{" "}
              {secondsLeft > 0 ? `valid ${secondsLeft}s` : "expired"}
            </div>
            <Button kind="ghost" onClick={() => setPrepared(null)}>
              Cancel
            </Button>
            <Button
              busy={action.busy}
              disabled={secondsLeft <= 0}
              onClick={() => action.run(send)}
            >
              Approve & send
              <ArrowUp size={15} />
            </Button>
          </div>
        )}
        <div className={`composer ${guard ? "blocked" : ""}`}>
          <textarea
            aria-label="Message"
            placeholder={
              allowed
                ? "Ask a question or give a task…"
                : "Approve your Office and seat to start a conversation."
            }
            value={prompt}
            disabled={!allowed || !!pending || action.busy || !!prepared}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={60000}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (!guard && prompt.trim() && !action.busy && !pending)
                  void action.run(quote);
              }
            }}
          />
          <div className="composer-controls">
            {lanes.length > 1 ? (
              <label className="switch">
                <input
                  type="checkbox"
                  checked={lane === "zero_retention"}
                  disabled={action.busy || !!pending || !!prepared}
                  onChange={(e) =>
                    setLane(e.target.checked ? "zero_retention" : "standard")
                  }
                />
                <span aria-hidden="true" />
                Zero retention
              </label>
            ) : (
              <span className="lane-label">
                <ShieldCheck size={14} />
                {lanes[0] === "zero_retention" ? "Zero retention" : "Standard processing"}
              </span>
            )}
            <details className="options">
              <summary>Options</summary>
              <div className="popover options-pop">
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
              </div>
            </details>
            <span className="composer-budget">
              Office has {money(available$)} USDG left
            </span>
            <Button
              className="send-button"
              busy={action.busy && !prepared}
              disabled={
                !allowed ||
                !prompt.trim() ||
                !!guard ||
                !chosen ||
                !!pending ||
                !!prepared
              }
              onClick={() => action.run(quote)}
            >
              Review price
              <ArrowUp size={15} />
            </Button>
          </div>
        </div>
        {guard ? (
          <div className="guard-message" role="alert">
            <ShieldCheck size={14} />
            {guard.message}
          </div>
        ) : (
          <p className="composer-note">
            Requests are quoted before you approve them. A signed receipt
            follows every completed request. Guards are on
            {lane === "zero_retention"
              ? " · response content is not stored."
              : "."}{" "}
            <kbd>⌘</kbd>
            <kbd>↵</kbd> to review price.
          </p>
        )}
      </div>
    </div>
  );
}
