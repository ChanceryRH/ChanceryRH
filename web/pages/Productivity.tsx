import { useEffect, useState } from "react";
import {
  Archive,
  ArrowUpRight,
  Bookmark,
  Check,
  Download,
  GitBranch,
  Library,
  Search,
  Star,
  Wallet,
  ListChecks,
  History,
  FileText,
  SlidersHorizontal,
  RefreshCw,
  Trash2,
  Pin,
  ShieldCheck,
} from "lucide-react";
import { useOffice } from "../App";
import { api, date, money, type Conversation, type Message } from "../api";
import {
  Button,
  Empty,
  Feedback,
  Field,
  Modal,
  Panel,
  submit,
  useAction,
} from "../ui";
import { SidePanel, SideItem, SideSection, Pill } from "../shell";
import {
  PRODUCTIVITY_UPDATES,
  type ProductivityId,
  type PersonalItem,
} from "../../shared/productivity";
import { openConversation } from "./Overview";
import "./Productivity.css";
const icons = [
  Library,
  GitBranch,
  Bookmark,
  Download,
  SlidersHorizontal,
  FileText,
  Star,
  Wallet,
  History,
  ListChecks,
];
export function Productivity() {
  const { config, office } = useOffice();
  const available = PRODUCTIVITY_UPDATES.filter((x) =>
    config.updates.some((u) => u.id === x.id && u.enabled),
  );
  const [tab, setTab] = useState<ProductivityId>(() => {
    const id = new URLSearchParams(location.hash.split("?")[1] || "").get(
      "tool",
    );
    return (
      available.find((x) => x.id === id)?.id ||
      available[0]?.id ||
      "chat_library"
    );
  });
  const availableKey = available.map((x) => x.id).join(",");
  useEffect(() => {
    const sync = () => {
      const requested = new URLSearchParams(
        location.hash.split("?")[1] || "",
      ).get("tool");
      if (available.some((x) => x.id === requested))
        setTab(requested as ProductivityId);
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [availableKey]);
  if (office.role === "guest" || !available.length)
    return (
      <Empty title="Your workspace tools" icon={<Library />}>
        These tools are available to active Office members when released.
      </Empty>
    );
  const chosen = available.find((x) => x.id === tab) || available[0];
  return (
    <>
      <SidePanel title="Your tools">
        <SideSection label="Make the work yours">
          {available.map((x) => {
            const Icon = icons[PRODUCTIVITY_UPDATES.indexOf(x)];
            return (
              <SideItem
                key={x.id}
                active={chosen.id === x.id}
                leading={<Icon size={16} />}
                title={x.name}
                onClick={() => {
                  setTab(x.id);
                  history.replaceState(null, "", `#/productivity?tool=${x.id}`);
                }}
              />
            );
          })}
        </SideSection>
        <p className="side-note">
          <ShieldCheck size={14} /> Personal tools stay scoped to your account
          and Office.
        </p>
      </SidePanel>
      <Tool key={`${office.id}:${chosen.id}`} id={chosen.id} />
    </>
  );
}
function Tool({ id }: { id: ProductivityId }) {
  const { office, models, navigate } = useOffice(),
    action = useAction();
  const info = PRODUCTIVITY_UPDATES.find((x) => x.id === id)!;
  const [data, setData] = useState<any>(null),
    [chats, setChats] = useState<Conversation[]>([]),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(0),
    [month, setMonth] = useState(new Date().toISOString().slice(0, 7)),
    [archive, setArchive] = useState(false);
  const [chat, setChat] = useState<Conversation | null>(null),
    [messages, setMessages] = useState<Message[]>([]),
    [messageId, setMessageId] = useState(""),
    [title, setTitle] = useState(""),
    [text, setText] = useState(""),
    [editing, setEditing] = useState<PersonalItem | null>(null),
    [due, setDue] = useState(""),
    [link, setLink] = useState(""),
    [manage, setManage] = useState<any>(null),
    [inspect, setInspect] = useState<any>(null),
    [deleting, setDeleting] = useState<PersonalItem | null>(null);
  const endpoint = `/productivity/${id}`;
  async function load() {
    if (
      [
        "chat_branches",
        "conversation_exports",
        "answer_vault",
        "action_lists",
      ].includes(id)
    )
      setChats(await api.office(office.id, "/conversations"));
    if (["chat_branches", "conversation_exports"].includes(id)) {
      setData([]);
      return;
    }
    const suffix =
      id === "spend_radar"
        ? `?month=${month}`
        : id === "request_history"
          ? `?page=${page}`
          : "";
    const value = await api.office(office.id, endpoint + suffix);
    setData(value);
    if (id === "personal_instructions") setText(value[0]?.value.text || "");
  }
  useEffect(() => {
    void action.run(load);
  }, [page, month]);
  const records: PersonalItem[] = Array.isArray(data) ? data : [];
  const filtered = records.filter((x) =>
    JSON.stringify(x.value).toLowerCase().includes(search.toLowerCase()),
  );
  const available = models.filter(
    (m) =>
      (!office.policy.allowedModels.length ||
        office.policy.allowedModels.includes(m.id)) &&
      m.lanes.some((l) => office.policy.allowedLanes.includes(l)),
  );
  function openChat(c: Conversation) {
    openConversation(c.id);
    navigate("chat");
  }
  async function selectChat(value: string) {
    const c = chats.find((c) => c.id === value) || null;
    setChat(c);
    setMessages([]);
    setMessageId("");
    if (c) {
      const m = await api.office(office.id, `/conversations/${c.id}/messages`);
      setMessages(m);
      setTitle(`${c.title} · another direction`.slice(0, 200));
    }
  }
  async function saveRecord(value: any) {
    await api.office(office.id, endpoint, value);
    await load();
    setEditing(null);
    setTitle("");
    setText("");
    setDue("");
    setLink("");
    action.setNotice("Saved securely in your personal workspace.");
  }
  async function removeItem(item: PersonalItem) {
    await api.request(
      `/offices/${office.id}${endpoint}/${item.id}?version=${item.version}`,
      undefined,
      "DELETE",
    );
    setDeleting(null);
    await load();
    action.setNotice("Removed.");
  }
  async function exportChat(format: "json" | "markdown") {
    if (!chat) return;
    const response = await fetch(
      `/api/offices/${office.id}/productivity/conversation_exports/${chat.id}?format=${format}`,
      { credentials: "include" },
    );
    if (!response.ok) {
      const value = await response.json();
      throw new Error(value.error?.message || "Export failed.");
    }
    const url = URL.createObjectURL(await response.blob()),
      a = document.createElement("a");
    a.href = url;
    a.download = `chancery-conversation.${format === "markdown" ? "md" : "json"}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    action.setNotice(
      "Downloaded. Your export contains the conversation text; share it only with people you choose.",
    );
  }
  const searchBox = (
    <label className="tool-search">
      <Search size={17} />
      <input
        aria-label="Search your items"
        placeholder="Find something worth keeping…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
    </label>
  );
  const chatPicker = (
    <Field label="Saved conversation">
      <select
        value={chat?.id || ""}
        disabled={action.busy}
        onChange={(e) => action.run(() => selectChat(e.target.value))}
      >
        <option value="">Choose a conversation</option>
        {chats
          .filter((c) => !c.ephemeral)
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
      </select>
    </Field>
  );
  return (
    <div className="productivity-page">
      <header className="tool-heading">
        <span className="eyebrow">YOUR WORK, WITH ROOM TO GROW</span>
        <div>
          <h1>{info.name}</h1>
          <Button
            kind="ghost"
            busy={action.busy}
            onClick={() => action.run(load)}
            aria-label="Refresh tools"
          >
            <RefreshCw size={16} />
          </Button>
        </div>
        <p>{info.description}</p>
      </header>
      <Feedback action={action} />
      {!data && !action.error && <p role="status">Loading your workspace…</p>}
      {id === "chat_library" && data && (
        <>
          <div className="tool-toolbar">
            {searchBox}
            <Button
              kind={archive ? "primary" : "secondary"}
              onClick={() => setArchive(!archive)}
            >
              <Archive size={16} />
              {archive ? "Show active" : "Show archived"}
            </Button>
          </div>
          <p className="muted">
            Your latest {data.limit} conversations · search titles · pins stay
            at the top.
          </p>
          <div className="tool-list">
            {data.conversations
              .filter(
                (c: any) =>
                  c.archived === archive &&
                  c.title.toLowerCase().includes(search.toLowerCase()),
              )
              .map((c: any) => (
                <Panel key={c.id} className="tool-row">
                  <div>
                    <h3>
                      {c.pinned && <Pin size={14} />} {c.title}
                    </h3>
                    <p>
                      {date(c.createdAt)}
                      {c.ephemeral ? " · Temporary" : ""}
                    </p>
                  </div>
                  <div className="tool-actions">
                    <Button
                      kind="secondary"
                      busy={action.busy}
                      onClick={() =>
                        action.run(async () => {
                          if (c.archived)
                            await api.office(office.id, `${endpoint}/${c.id}`, {
                              title: c.title,
                              pinned: c.pinned,
                              archived: false,
                            });
                          openChat(c);
                        })
                      }
                    >
                      {c.archived ? "Restore & open" : "Open"}{" "}
                      <ArrowUpRight size={14} />
                    </Button>
                    <Button kind="ghost" onClick={() => setManage({ ...c })}>
                      Organize
                    </Button>
                  </div>
                </Panel>
              ))}
          </div>
          {!data.conversations.some(
            (c: any) =>
              c.archived === archive &&
              c.title.toLowerCase().includes(search.toLowerCase()),
          ) && (
            <Empty
              title={archive ? "No archived chats" : "Nothing here yet"}
              icon={<Library />}
            >
              Your matching conversations will appear here.
            </Empty>
          )}
          {manage && (
            <Modal title="Organize conversation" close={() => setManage(null)}>
              <form
                onSubmit={submit(() =>
                  action.run(async () => {
                    await api.office(office.id, `${endpoint}/${manage.id}`, {
                      title: manage.title,
                      pinned: manage.pinned,
                      archived: manage.archived,
                    });
                    setManage(null);
                    await load();
                  }),
                )}
              >
                <Field label="Conversation title">
                  <input
                    maxLength={200}
                    required
                    value={manage.title}
                    onChange={(e) =>
                      setManage({ ...manage, title: e.target.value })
                    }
                  />
                </Field>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={manage.pinned}
                    onChange={(e) =>
                      setManage({ ...manage, pinned: e.target.checked })
                    }
                  />
                  Pin to the top
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={manage.archived}
                    onChange={(e) =>
                      setManage({ ...manage, archived: e.target.checked })
                    }
                  />
                  Archive from your active list
                </label>
                <Button type="submit" busy={action.busy}>
                  Save changes
                </Button>
              </form>
            </Modal>
          )}
        </>
      )}
      {["chat_branches", "conversation_exports", "answer_vault"].includes(
        id,
      ) && (
        <Panel className="tool-editor">
          {chatPicker}
          {chat && (
            <>
              <p className="muted">
                {messages.length} retained messages. Temporary chats are
                excluded.
              </p>
              {id === "conversation_exports" ? (
                <>
                  <div className="tool-actions">
                    <Button
                      busy={action.busy}
                      disabled={!messages.length}
                      onClick={() => action.run(() => exportChat("markdown"))}
                    >
                      <Download size={16} />
                      Download Markdown
                    </Button>
                    <Button
                      kind="secondary"
                      busy={action.busy}
                      disabled={!messages.length}
                      onClick={() => action.run(() => exportChat("json"))}
                    >
                      Download JSON
                    </Button>
                  </div>
                  <p className="muted">
                    Downloads contain plaintext. Billing receipts remain in the
                    Ledger.
                  </p>
                </>
              ) : (
                <>
                  <Field
                    label={
                      id === "chat_branches"
                        ? "Branch through this message"
                        : "Answer to keep"
                    }
                  >
                    <select
                      value={messageId}
                      onChange={(e) => setMessageId(e.target.value)}
                    >
                      <option value="">Choose a message</option>
                      {messages
                        .filter(
                          (m) =>
                            id === "chat_branches" || m.role === "assistant",
                        )
                        .map((m, i) => (
                          <option value={m.id} key={m.id}>
                            {i + 1}.{" "}
                            {m.role === "assistant" ? "Assistant" : "You"} ·{" "}
                            {m.content.slice(0, 110)}
                          </option>
                        ))}
                    </select>
                  </Field>
                  {messageId && (
                    <pre className="tool-excerpt">
                      {messages.find((m) => m.id === messageId)?.content}
                    </pre>
                  )}
                  <Field
                    label={
                      id === "chat_branches"
                        ? "Name your new direction"
                        : "Save as"
                    }
                  >
                    <input
                      maxLength={id === "chat_branches" ? 200 : 160}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </Field>
                  <Button
                    busy={action.busy}
                    disabled={!messageId || !title.trim()}
                    onClick={() =>
                      action.run(async () => {
                        if (id === "chat_branches") {
                          const result = await api.office(office.id, endpoint, {
                            conversationId: chat.id,
                            throughMessageId: messageId,
                            title,
                          });
                          openConversation(result.id);
                          navigate("chat");
                        } else {
                          await api.office(office.id, endpoint, {
                            conversationId: chat.id,
                            messageId,
                            label: title,
                          });
                          await load();
                          action.setNotice("Answer saved to your Vault.");
                        }
                      })
                    }
                  >
                    {id === "chat_branches" ? (
                      <GitBranch size={16} />
                    ) : (
                      <Bookmark size={16} />
                    )}{" "}
                    {id === "chat_branches" ? "Create branch" : "Save answer"}
                  </Button>
                  <p className="muted">
                    {id === "chat_branches"
                      ? "Copies the saved messages up to this point. Your original stays intact. No AI request or charge is created."
                      : "A separate encrypted copy stays in your Vault until you remove it, even if you delete the source chat."}
                  </p>
                </>
              )}
            </>
          )}
        </Panel>
      )}
      {id === "answer_vault" && (
        <>
          {searchBox}
          <div className="tool-cards">
            {filtered.map((item) => (
              <Panel key={item.id} className="tool-card">
                <Bookmark size={19} />
                <h2>{item.value.label}</h2>
                <p className="muted">
                  {models.find((m) => m.id === item.value.model)?.name ||
                    item.value.model}{" "}
                  · {date(item.createdAt)}
                </p>
                <pre className="tool-excerpt">{item.value.content}</pre>
                <div className="tool-actions">
                  <Button
                    kind="secondary"
                    onClick={() =>
                      action.run(async () => {
                        await navigator.clipboard.writeText(item.value.content);
                        action.setNotice("Answer copied.");
                      })
                    }
                  >
                    Copy answer
                  </Button>
                  <Button kind="ghost" onClick={() => setDeleting(item)}>
                    Remove
                  </Button>
                </div>
              </Panel>
            ))}
          </div>
          {!filtered.length && (
            <Empty
              title="Keep the answers you come back to"
              icon={<Bookmark />}
            >
              Choose a saved conversation above and keep one of its assistant
              answers.
            </Empty>
          )}
        </>
      )}
      {id === "personal_instructions" && data && (
        <Panel className="tool-editor">
          <ShieldCheck size={23} />
          <h2>A little context goes a long way.</h2>
          <p>
            Save your preferred tone, audience, and working style. In chat,
            choose “Use my instructions” before reviewing the price. They are
            never applied silently.
          </p>
          <form
            onSubmit={submit(() =>
              action.run(async () => {
                await api.office(office.id, endpoint, {
                  text,
                  version: records[0]?.version || 0,
                });
                await load();
                action.setNotice(
                  "Instructions saved. Choose when to include them in chat.",
                );
              }),
            )}
          >
            <Field
              label="Your instructions"
              help="Up to 6,000 characters. Avoid credentials and confidential secrets."
            >
              <textarea
                rows={10}
                maxLength={6000}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Use clear, concise language. Explain assumptions. Write for our customers…"
              />
            </Field>
            <div className="tool-actions">
              <Button type="submit" busy={action.busy}>
                Save instructions
              </Button>
              <Button kind="secondary" onClick={() => navigate("chat")}>
                Open chat <ArrowUpRight size={14} />
              </Button>
            </div>
          </form>
          <p className="muted">
            Encrypted at rest. When you explicitly include them, they are sent
            with that request to your selected model. Save empty text to clear
            them.
          </p>
        </Panel>
      )}
      {id === "draft_recovery" && (
        <>
          <Panel className="tool-editor">
            <h2>
              {editing
                ? "Edit your saved draft"
                : "Leave a thought here. Come back ready."}
            </h2>
            <form
              onSubmit={submit(() =>
                action.run(() =>
                  saveRecord({
                    ...(editing ? { id: editing.id } : {}),
                    title,
                    text,
                    version: editing?.version || 0,
                  }),
                ),
              )}
            >
              <Field label="Draft title">
                <input
                  value={title}
                  required
                  maxLength={160}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <Field
                label="Unfinished prompt"
                help="Saved only when you choose. This does not send anything to an AI model."
              >
                <textarea
                  required
                  rows={7}
                  maxLength={60000}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </Field>
              <Button type="submit" busy={action.busy}>
                Save draft securely
              </Button>
              {editing && (
                <Button
                  kind="ghost"
                  onClick={() => {
                    setEditing(null);
                    setTitle("");
                    setText("");
                  }}
                >
                  Cancel editing
                </Button>
              )}
            </form>
          </Panel>
          {searchBox}
          <div className="tool-cards">
            {filtered.map((item) => (
              <Panel key={item.id} className="tool-card">
                <FileText size={20} />
                <h2>{item.value.title}</h2>
                <p>{date(item.updatedAt)}</p>
                <pre className="tool-excerpt">{item.value.text}</pre>
                <div className="tool-actions">
                  <Button
                    onClick={() => {
                      sessionStorage.setItem(
                        `chancery:restore-draft:${office.id}`,
                        item.id,
                      );
                      navigate("chat");
                    }}
                  >
                    Restore to chat
                  </Button>
                  <Button
                    kind="ghost"
                    onClick={() => {
                      setEditing(item);
                      setTitle(item.value.title);
                      setText(item.value.text);
                    }}
                  >
                    Edit
                  </Button>
                  <Button kind="ghost" onClick={() => setDeleting(item)}>
                    Delete
                  </Button>
                </div>
              </Panel>
            ))}
          </div>
        </>
      )}
      {id === "model_favorites" && data && (
        <>
          {searchBox}
          <p className="muted">
            Favorites are personal to this Office. Models still follow your
            Office’s policy and quoted pricing.
          </p>
          <div className="tool-cards">
            {available
              .filter((m) =>
                (m.name + " " + m.id)
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((m) => {
                const ids: string[] = records[0]?.value.models || [],
                  fav = ids.includes(m.id);
                return (
                  <Panel
                    key={m.id}
                    className={`tool-card ${fav ? "favorite-card" : ""}`}
                  >
                    <div className="tool-card-top">
                      <Star size={22} fill={fav ? "currentColor" : "none"} />
                      <Pill>{fav ? "Favorite" : "Available"}</Pill>
                    </div>
                    <h2>{m.name}</h2>
                    <p>{m.contextLength.toLocaleString()} context tokens</p>
                    <p className="muted">
                      Input {money(m.inputUsdPerMillion)} / output{" "}
                      {money(m.outputUsdPerMillion)} USDG per million tokens
                    </p>
                    <div className="tool-actions">
                      <Button
                        kind={fav ? "secondary" : "primary"}
                        busy={action.busy}
                        onClick={() =>
                          action.run(async () => {
                            await api.office(office.id, endpoint, {
                              models: fav
                                ? ids.filter(
                                    (x) =>
                                      x !== m.id &&
                                      available.some((model) => model.id === x),
                                  )
                                : [
                                    ...ids.filter((x) =>
                                      available.some((m) => m.id === x),
                                    ),
                                    m.id,
                                  ],
                              version: records[0]?.version || 0,
                            });
                            await load();
                          })
                        }
                      >
                        {fav ? "Remove favorite" : "Add favorite"}
                      </Button>
                      <Button
                        kind="ghost"
                        onClick={() => {
                          sessionStorage.setItem(
                            `chancery:chosen-model:${office.id}`,
                            m.id,
                          );
                          navigate("chat");
                        }}
                      >
                        Use in chat
                      </Button>
                    </div>
                  </Panel>
                );
              })}
          </div>
          {!available.length && (
            <Empty title="No available models" icon={<Star />}>
              Your Office policy and current catalog determine which models
              appear here.
            </Empty>
          )}
        </>
      )}
      {id === "spend_radar" && data && (
        <>
          <div className="tool-toolbar">
            <Field label="Receipt month">
              <input
                type="month"
                disabled={action.busy}
                value={month}
                onChange={(e) => {
                  if (e.target.value) setMonth(e.target.value);
                }}
              />
            </Field>
            <Pill>{data.scope}</Pill>
          </div>
          <div className="radar-stats">
            {[
              ["Recorded charges", data.totalUsd],
              ["AI usage + fees", data.usageUsd],
              ["Seat fees", data.seatUsd],
              ["Awaiting settlement", data.unsettledUsd],
            ].map(([label, value]) => (
              <Panel key={label} className="radar-stat">
                <span>{label}</span>
                <strong>{money(value, 4)}</strong>
                <small>USDG</small>
              </Panel>
            ))}
          </div>
          <div className="tool-two-col">
            <Panel className="tool-editor">
              <h2>Where your AI spend went</h2>
              <p className="muted">
                {data.receiptCount} signed receipts in this month. Receipt
                platform fees: {money(data.platformFeeUsd, 4)} USDG.
              </p>
              {data.models.map((m: any) => (
                <div className="radar-model" key={m.model}>
                  <div>
                    <strong>
                      {models.find((x) => x.id === m.model)?.name || m.model}
                    </strong>
                    <span>
                      {money(m.chargedUsd, 4)} USDG · {m.requests} requests
                    </span>
                  </div>
                  <progress
                    max={Math.max(Number(data.usageUsd), 0.000001)}
                    value={Number(m.chargedUsd)}
                  />
                </div>
              ))}
              {!data.models.length && (
                <p>No AI usage receipts in this month yet.</p>
              )}
            </Panel>
            <Panel className="tool-editor">
              <Wallet size={22} />
              <h2>Office allowance</h2>
              <strong className="radar-budget">
                {money(
                  Math.max(0, Number(office.capUsd) - Number(office.spentUsd)),
                )}
              </strong>
              <p>USDG before unsettled usage and in-flight reservations.</p>
              <p className="muted">
                {money(office.spentUsd)} settled of {money(office.capUsd)} this
                30-day cycle. Receipt months and allowance cycles are different
                periods.
              </p>
              <Button kind="secondary" onClick={() => navigate("ledger")}>
                Inspect signed receipts
              </Button>
            </Panel>
          </div>
          {data.provisional > 0 && (
            <div className="notice warning">
              {data.provisional} provisional receipts have unresolved costs.
              Recorded totals can change after reconciliation.
            </div>
          )}
          {data.limited && (
            <div className="notice warning">
              Showing the latest 5,000 receipts. Export the Ledger for a
              complete statement.
            </div>
          )}
        </>
      )}
      {id === "request_history" && data && (
        <>
          <p className="muted">
            Your requests only. “Inspect” reads the existing result; it never
            retries inference.
          </p>
          <div className="tool-list">
            {data.requests.map((r: any) => (
              <Panel key={r.id} className="tool-row">
                <div>
                  <h3>
                    {models.find((m) => m.id === r.model)?.name || r.model}
                  </h3>
                  <p>
                    {date(r.createdAt)} ·{" "}
                    {r.lane === "zero_retention"
                      ? "Zero retention"
                      : "Standard"}
                  </p>
                  <small className="tool-id">{r.id}</small>
                </div>
                <div className="tool-actions">
                  <Pill>{r.status}</Pill>
                  <span>
                    {r.chargedUsd === null
                      ? `${money(r.reservedUsd, 4)} reserved`
                      : `${money(r.chargedUsd, 4)} USDG`}
                  </span>
                  <Button
                    kind="secondary"
                    busy={action.busy}
                    onClick={() =>
                      action.run(async () =>
                        setInspect(
                          await api.office(office.id, `/requests/${r.id}`),
                        ),
                      )
                    }
                  >
                    Inspect
                  </Button>
                </div>
              </Panel>
            ))}
          </div>
          {!data.requests.length && (
            <Empty title="Your work leaves a record" icon={<History />}>
              Completed, failed, and unresolved requests will appear here.
            </Empty>
          )}
          <div className="tool-actions">
            <Button
              kind="secondary"
              disabled={page === 0 || action.busy}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <span>Page {page + 1}</span>
            <Button
              kind="secondary"
              disabled={!data.hasMore || action.busy}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
          {inspect && (
            <Modal title="Request details" close={() => setInspect(null)}>
              <p>
                Status: <strong>{inspect.status}</strong>
              </p>
              <p>Reserved maximum: {money(inspect.reservedUsd, 6)} USDG</p>
              <p>
                Recorded charge:{" "}
                {inspect.chargedUsd === null
                  ? "Unresolved"
                  : money(inspect.chargedUsd, 6) + " USDG"}
              </p>
              {inspect.content ? (
                <pre className="tool-excerpt">{inspect.content}</pre>
              ) : (
                <p>Response content is not retained or is not available yet.</p>
              )}
              {inspect.error && <p>{inspect.error}</p>}
              <p className="muted">
                Receipt: {inspect.receipt?.payload?.id || "Not available yet"}
              </p>
              <Button kind="secondary" onClick={() => navigate("ledger")}>
                Open Ledger
              </Button>
            </Modal>
          )}
        </>
      )}
      {id === "action_lists" && (
        <>
          <Panel className="tool-editor">
            <h2>
              {editing
                ? "Update your next step"
                : "Make your next step concrete."}
            </h2>
            <form
              onSubmit={submit(() =>
                action.run(() =>
                  saveRecord({
                    ...(editing ? { id: editing.id } : {}),
                    title,
                    notes: text,
                    due: due || null,
                    done: editing?.value.done || false,
                    conversationId: link || null,
                    version: editing?.version || 0,
                  }),
                ),
              )}
            >
              <Field label="Task">
                <input
                  required
                  maxLength={200}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <Field label="Notes">
                <textarea
                  maxLength={4000}
                  rows={3}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </Field>
              <div className="tool-two-col">
                <Field label="Due date (optional)">
                  <input
                    type="date"
                    value={due}
                    onChange={(e) => setDue(e.target.value)}
                  />
                </Field>
                <Field label="Related conversation (optional)">
                  <select
                    value={link}
                    onChange={(e) => setLink(e.target.value)}
                  >
                    <option value="">No conversation</option>
                    {chats.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Button type="submit" busy={action.busy}>
                {editing ? "Save task" : "Add task"}
              </Button>
              {editing && (
                <Button
                  kind="ghost"
                  onClick={() => {
                    setEditing(null);
                    setTitle("");
                    setText("");
                    setDue("");
                    setLink("");
                  }}
                >
                  Cancel editing
                </Button>
              )}
            </form>
          </Panel>
          {searchBox}
          <div className="tool-list">
            {filtered
              .slice()
              .sort(
                (a, b) =>
                  Number(a.value.done) - Number(b.value.done) ||
                  (a.value.due || "9999").localeCompare(b.value.due || "9999"),
              )
              .map((item) => (
                <Panel
                  key={item.id}
                  className={`tool-row ${item.value.done ? "task-done" : ""}`}
                >
                  <div>
                    <h3>
                      {item.value.done && <Check size={16} />}{" "}
                      {item.value.title}
                    </h3>
                    <p>{item.value.notes}</p>
                    {item.value.due && <Pill>Due {item.value.due}</Pill>}
                  </div>
                  <div className="tool-actions">
                    <Button
                      busy={action.busy}
                      kind="secondary"
                      onClick={() =>
                        action.run(async () => {
                          await api.office(office.id, endpoint, {
                            id: item.id,
                            ...item.value,
                            done: !item.value.done,
                            version: item.version,
                          });
                          await load();
                        })
                      }
                    >
                      {item.value.done ? "Reopen" : "Complete"}
                    </Button>
                    {item.value.conversationId &&
                      chats.some((c) => c.id === item.value.conversationId) && (
                        <Button
                          kind="ghost"
                          onClick={() =>
                            openChat(
                              chats.find(
                                (c) => c.id === item.value.conversationId,
                              )!,
                            )
                          }
                        >
                          Open chat
                        </Button>
                      )}
                    <Button
                      kind="ghost"
                      onClick={() => {
                        setEditing(item);
                        setTitle(item.value.title);
                        setText(item.value.notes);
                        setDue(item.value.due || "");
                        setLink(item.value.conversationId || "");
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      kind="ghost"
                      onClick={() => setDeleting(item)}
                      aria-label={`Delete task ${item.value.title}`}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                </Panel>
              ))}
          </div>
          <p className="muted">
            Tasks are personal to you in this Office. Completing a task does not
            run AI work or move funds.
          </p>
        </>
      )}
      {deleting && (
        <Modal title="Remove this saved item?" close={() => setDeleting(null)}>
          <p>This permanently removes your saved copy.</p>
          <Button
            kind="danger"
            busy={action.busy}
            onClick={() => action.run(() => removeItem(deleting))}
          >
            Remove item
          </Button>
          <Button kind="ghost" onClick={() => setDeleting(null)}>
            Keep it
          </Button>
        </Modal>
      )}
    </div>
  );
}
