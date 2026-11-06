import "../agent-hub.css";
import { useEffect, useState, useRef } from "react";
import { Plug, ShieldCheck, Copy, RefreshCw } from "lucide-react";
import { useOffice } from "../App";
import { api, date, errorText, money, type Quote } from "../api";
import {
  Button,
  Feedback,
  Field,
  Modal,
  Panel,
  submit,
  useAction,
} from "../ui";
import { Pill } from "../shell";
import {
  MCP_SCOPES,
  type McpScope,
  type McpConnection,
  type McpDraft,
} from "../../shared/mcp";

export function Connections() {
  const { office } = useOffice(),
    action = useAction();
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [drafts, setDrafts] = useState<McpDraft[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [budgetUsd, setBudgetUsd] = useState("25");
  const [maxRequestUsd, setMaxRequestUsd] = useState("1");
  const [budgetTarget, setBudgetTarget] = useState<McpConnection | null>(null);
  const [limit, setLimit] = useState("25");
  const [maximum, setMaximum] = useState("1");
  const [allRevoke, setAllRevoke] = useState(false);
  const [activityTarget, setActivityTarget] = useState<McpConnection | null>(
    null,
  );
  const [activity, setActivity] = useState<any>(null);
  const opened = useRef("");
  const state = (c: McpConnection) =>
    c.revoked_at
      ? "revoked"
      : new Date(c.expires_at).getTime() <= Date.now()
        ? "expired"
        : c.paused_at
          ? "paused"
          : "active";
  async function loadActivity(c: McpConnection, offset = 0) {
    const data = await api.office(
      office.id,
      base + "/connections/" + c.id + "/activity?offset=" + offset,
    );
    setActivity(data);
    setActivityTarget(c);
  }
  const [days, setDays] = useState(7);
  const [scopes, setScopes] = useState<McpScope[]>([
    "workspace:read",
    "models:read",
  ]);
  const [created, setCreated] = useState<{
    token: string;
    endpoint: string;
    expiresAt: string;
  } | null>(null);
  const [selected, setSelected] = useState<McpDraft | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [revoking, setRevoking] = useState<McpConnection | null>(null);
  const base = "/mcp";
  async function refresh() {
    const [c, d] = await Promise.all([
      api.office(office.id, base + "/connections"),
      api.office(office.id, base + "/requests"),
    ]);
    setConnections(c);
    setDrafts(d);
    setLoaded(true);
  }
  useEffect(() => {
    let live = true;
    Promise.all([
      api.office(office.id, base + "/connections"),
      api.office(office.id, base + "/requests"),
    ])
      .then(([c, d]) => {
        if (live) {
          setConnections(c);
          setDrafts(d);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (live) action.setError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [office.id]);
  useEffect(() => {
    const open = () => {
      const params = new URLSearchParams(location.hash.split("?")[1] || "");
      const request = params.get("request");
      if (params.get("office") && params.get("office") !== office.id) return;
      const target = drafts.find((d) => d.id === request);
      if (target && opened.current !== request) {
        opened.current = request!;
        setQuote(null);
        setSelected(target);
      }
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, [drafts, office.id]);
  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    action.setNotice("Copied.");
  }
  const endpoint = window.location.origin + "/mcp";
  const pending = drafts.filter(
    (d) =>
      ["pending", "retryable"].includes(d.status) &&
      new Date(d.expiresAt).getTime() > Date.now(),
  );
  const visibleScopes = MCP_SCOPES.filter(
    (s) =>
      s.id !== "clerks:read" || ["principal", "officer"].includes(office.role),
  );
  return (
    <div className="mcp-connections">
      <div className="notice">
        <ShieldCheck size={18} />
        <span>
          Every connection is limited to this Office and its selected
          permissions. Prepared AI work waits for your price approval here.
        </span>
      </div>
      <Feedback action={action} />
      <div className="agent-stats">
        <div>
          <strong>
            {connections.filter((c) => state(c) === "active").length}
          </strong>
          <span>Active agents</span>
        </div>
        <div>
          <strong>{pending.length}</strong>
          <span>Awaiting approval</span>
        </div>
        <div>
          <strong>
            {connections.filter((c) => state(c) === "paused").length}
          </strong>
          <span>Paused</span>
        </div>
      </div>
      <div className="agent-toolbar">
        <Button kind="secondary" onClick={() => setShowConnect((v) => !v)}>
          {showConnect ? "Hide connection setup" : "Connect an agent"}
        </Button>
        <span className="muted">
          Add the MCP endpoint in a compatible client to connect with consent,
          or create a scoped token below.
        </span>
      </div>
      {(showConnect || connections.length === 0) && (
        <Panel className="card">
          <div className="card-head">
            <div>
              <h2>
                <Plug size={20} /> Connect your AI tools
              </h2>
              <p>
                MCP endpoint for OAuth-capable clients. Manual tokens are
                available for clients that support bearer authentication.
              </p>
            </div>
            <Pill tone="green">Human approval</Pill>
          </div>
          <Field label="MCP endpoint">
            <div className="mcp-inline">
              <input readOnly value={endpoint} aria-label="MCP endpoint" />
              <Button
                kind="secondary"
                onClick={() => void action.run(() => copy(endpoint))}
              >
                <Copy size={15} /> Copy
              </Button>
            </div>
          </Field>
          <form
            className="mcp-form"
            onSubmit={submit(() =>
              action.run(async () => {
                const result = await api.office(
                  office.id,
                  base + "/connections",
                  {
                    name,
                    scopes,
                    expiresInDays: days,
                    budgetUsd,
                    maxRequestUsd,
                  },
                );
                setCreated(result);
                setShowConnect(false);
                setName("");
                await refresh();
              }),
            )}
          >
            <div className="mcp-form-grid">
              <Field label="Connection name">
                <input
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My AI workspace"
                  autoComplete="off"
                />
              </Field>
              <Field label="Expires after">
                <select
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                >
                  <option value={1}>1 day</option>
                  <option value={7}>7 days</option>
                  <option value={30}>30 days</option>
                </select>
              </Field>
            </div>
            <div className="mcp-form-grid">
              <Field label="Rolling 24-hour budget · USD">
                <input
                  value={budgetUsd}
                  onChange={(e) => setBudgetUsd(e.target.value)}
                  required
                  inputMode="decimal"
                  pattern="[0-9]+([.][0-9]{1,6})?"
                />
              </Field>
              <Field label="Maximum per request · USD">
                <input
                  value={maxRequestUsd}
                  onChange={(e) => setMaxRequestUsd(e.target.value)}
                  required
                  inputMode="decimal"
                  pattern="[0-9]+([.][0-9]{1,6})?"
                />
              </Field>
            </div>
            <p className="muted">
              Limits cover AI requests through this connection. Office and seat
              limits still apply. Every request requires your approval.
            </p>
            <fieldset className="mcp-permissions">
              <legend>Choose what this tool can access</legend>
              {visibleScopes.map((s) => (
                <label key={s.id} className="mcp-permission">
                  <input
                    type="checkbox"
                    checked={scopes.includes(s.id)}
                    onChange={(e) =>
                      setScopes((old) =>
                        e.target.checked
                          ? [...old, s.id]
                          : old.filter((v) => v !== s.id),
                      )
                    }
                  />
                  <span>
                    <strong>{s.name}</strong>
                    <small>{s.detail}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <p className="muted">
              Selected data is shared with the AI client using this token.
              Create a separate connection for each client. You may need to sign
              in again before creating one.
            </p>
            <Button
              type="submit"
              busy={action.busy}
              disabled={!name.trim() || !scopes.length}
            >
              Create connection
            </Button>
          </form>
        </Panel>
      )}
      <Panel className="card">
        <div className="card-head">
          <div>
            <h2>Your agents</h2>
            <p>
              {office.role === "principal"
                ? "You can revoke any connection in this Office."
                : "Revoke a connection whenever you need."}
            </p>
          </div>
          <Button
            kind="ghost"
            busy={action.busy}
            onClick={() => void action.run(refresh)}
          >
            <RefreshCw size={15} /> Refresh
          </Button>
        </div>
        <div className="agent-toolbar">
          <input
            aria-label="Search agents"
            placeholder="Find an agent…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            aria-label="Agent status"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            {["all", "active", "paused", "expired", "revoked"].map((s) => (
              <option key={s} value={s}>
                {s === "all" ? "All statuses" : s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
          <Button
            kind="danger"
            disabled={!connections.some((c) => !c.revoked_at)}
            onClick={() => setAllRevoke(true)}
          >
            Revoke all
          </Button>
        </div>
        {!loaded ? (
          <p className="muted">Loading connections…</p>
        ) : !connections.length ? (
          <p className="muted">No AI tools connected yet.</p>
        ) : (
          connections
            .filter(
              (c) =>
                c.name.toLowerCase().includes(search.toLowerCase()) &&
                (filter === "all" || state(c) === filter),
            )
            .map((c) => {
              const active =
                !c.revoked_at && new Date(c.expires_at).getTime() > Date.now();
              return (
                <div className="mcp-connection-row" key={c.id}>
                  <div>
                    <strong>{c.name}</strong>
                    <p className="muted">
                      {c.scopes
                        .map((s) => MCP_SCOPES.find((x) => x.id === s)?.name)
                        .join(" · ")}
                    </p>
                    <small className="muted">
                      Expires {date(c.expires_at)} ·{" "}
                      {c.last_used_at
                        ? "Last used " + date(c.last_used_at)
                        : "Not used yet"}
                    </small>
                    <p className="agent-budget">
                      {c.remainingUsd === null
                        ? "Office and seat limits apply"
                        : `${money(c.remainingUsd, 2)} USD available · ${money(c.budgetUsd!, 2)} / rolling 24h`}{" "}
                      ·{" "}
                      {c.maxRequestUsd === null
                        ? "Office request limit"
                        : `${money(c.maxRequestUsd, 2)} USD / request`}
                    </p>
                  </div>
                  <div className="mcp-inline">
                    <Pill tone={state(c) === "active" ? "green" : "amber"}>
                      {state(c)}
                    </Pill>
                    <Button
                      kind="ghost"
                      onClick={() => void action.run(() => loadActivity(c))}
                    >
                      Activity
                    </Button>
                    {active && (
                      <>
                        <Button
                          kind="secondary"
                          busy={action.busy}
                          onClick={() =>
                            void action.run(async () => {
                              await api.office(
                                office.id,
                                base + "/connections/" + c.id + "/control",
                                { action: c.paused_at ? "resume" : "pause" },
                              );
                              await refresh();
                            })
                          }
                        >
                          {c.paused_at ? "Resume" : "Pause"}
                        </Button>
                        <Button
                          kind="secondary"
                          onClick={() => {
                            setLimit(c.budgetUsd || "25");
                            setMaximum(c.maxRequestUsd || "1");
                            setBudgetTarget(c);
                          }}
                        >
                          Limits
                        </Button>
                      </>
                    )}
                    {active && (
                      <Button kind="danger" onClick={() => setRevoking(c)}>
                        Revoke
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
        )}
      </Panel>
      <Panel className="card">
        <div className="card-head">
          <div>
            <h2>Approval inbox</h2>
            <p>
              {pending.length} awaiting your review. Nothing runs until you
              approve its price.
            </p>
          </div>
        </div>
        {!drafts.length ? (
          <p className="muted">
            Requests from your connected tools will appear here. Refresh to
            check for new work.
          </p>
        ) : (
          drafts.map((d) => (
            <div className="mcp-connection-row" key={d.id}>
              <div>
                <strong>{d.connectionName}</strong>
                <p className="mcp-prompt-snippet">
                  {d.chat.messages[0]?.content}
                </p>
                <small className="muted">
                  {d.chat.model} · {date(d.createdAt)}
                </small>
              </div>
              <div className="mcp-inline">
                <Pill
                  tone={
                    ["pending", "retryable"].includes(d.status)
                      ? "amber"
                      : "green"
                  }
                >
                  {d.result?.status || d.status}
                </Pill>
                <Button
                  kind="secondary"
                  onClick={() => {
                    setQuote(null);
                    setSelected(d);
                  }}
                >
                  {["pending", "retryable"].includes(d.status)
                    ? "Review request"
                    : "View"}
                </Button>
              </div>
            </div>
          ))
        )}
      </Panel>
      {budgetTarget && (
        <Modal
          title={"Limits for " + budgetTarget.name}
          close={() => setBudgetTarget(null)}
        >
          <p>
            Reserved and uncertain requests count toward the budget until their
            costs are resolved. Lowering a limit never cancels already-running
            work.
          </p>
          <form
            onSubmit={submit(() =>
              action.run(async () => {
                await api.office(
                  office.id,
                  base + "/connections/" + budgetTarget.id + "/budget",
                  { budgetUsd: limit, maxRequestUsd: maximum },
                );
                setBudgetTarget(null);
                await refresh();
              }),
            )}
          >
            <Field label="Rolling 24-hour budget · USD">
              <input
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                required
                inputMode="decimal"
              />
            </Field>
            <Field label="Maximum per request · USD">
              <input
                value={maximum}
                onChange={(e) => setMaximum(e.target.value)}
                required
                inputMode="decimal"
              />
            </Field>
            <Button type="submit" busy={action.busy}>
              Save limits
            </Button>
          </form>
          <Feedback action={action} />
        </Modal>
      )}
      {allRevoke && (
        <Modal
          title={
            office.role === "principal"
              ? "Revoke every agent in this Office?"
              : "Revoke all your agents?"
          }
          close={() => setAllRevoke(false)}
        >
          <p>
            This permanently cuts off new access and rejects pending requests.
            Work already executing may finish. Reconnecting requires a new token
            or consent.
          </p>
          <Button
            kind="danger"
            busy={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api.office(
                  office.id,
                  base + "/connections/revoke-all",
                  {},
                );
                setAllRevoke(false);
                await refresh();
              })
            }
          >
            Confirm revoke all
          </Button>
          <Feedback action={action} />
        </Modal>
      )}
      {activityTarget && activity && (
        <Modal
          title={activityTarget.name + " · Activity"}
          close={() => {
            setActivityTarget(null);
            setActivity(null);
          }}
        >
          <p>
            Agent-specific requests and control events. See Ledger for the
            Office’s complete spending record.
          </p>
          {activity.items.length === 0 && <p>No requests yet.</p>}
          {activity.items.map((item: any) => (
            <div className="agent-event" key={item.id}>
              <strong>{item.execution_status || item.approval_status}</strong>
              <small>
                {date(item.created_at)} · {item.model || "Prepared request"}
              </small>
              <span>
                {item.chargedUsd !== null
                  ? money(item.chargedUsd, 6) + " USD charged"
                  : item.reservedUsd !== null
                    ? money(item.reservedUsd, 6) + " USD reserved"
                    : "No charge"}
              </span>
              {item.receipt_id && (
                <Button
                  kind="secondary"
                  onClick={() =>
                    void action.run(async () => {
                      const proof = await api.office(
                        office.id,
                        "/ledger/" + item.receipt_id + "/proof",
                      );
                      const blob = new Blob([JSON.stringify(proof, null, 2)], {
                        type: "application/json",
                      });
                      const url = URL.createObjectURL(blob);
                      const link = document.createElement("a");
                      link.href = url;
                      link.download =
                        "chancery-receipt-" + item.receipt_id + ".json";
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    })
                  }
                >
                  Download receipt proof
                </Button>
              )}
            </div>
          ))}
          {activity.nextOffset !== null && (
            <Button
              kind="secondary"
              onClick={() =>
                void action.run(() =>
                  loadActivity(activityTarget, activity.nextOffset),
                )
              }
            >
              Older requests
            </Button>
          )}
          <h3>Connection events</h3>
          {activity.events.map((item: any, i: number) => (
            <p key={i}>
              {item.action.replace(/^mcp\./, "").replaceAll("_", " ")} ·{" "}
              {date(item.created_at)}
            </p>
          ))}
          <Feedback action={action} />
        </Modal>
      )}
      {created && (
        <Modal
          title="Save your connection token"
          close={() => setCreated(null)}
        >
          <p>
            This token is shown once. Paste it into your AI client’s
            bearer-token field. Keep it out of chats and source files.
          </p>
          <Field label="Connection token">
            <input
              type="password"
              readOnly
              value={created.token}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <div className="mcp-inline">
            <Button onClick={() => void action.run(() => copy(created.token))}>
              <Copy size={15} /> Copy token
            </Button>
            <Button kind="secondary" onClick={() => setCreated(null)}>
              I’ve saved it
            </Button>
          </div>
          <p className="muted">
            Expires {date(created.expiresAt)}. Limited to the Office and
            permissions you selected.
          </p>
          <Feedback action={action} />
        </Modal>
      )}
      {revoking && (
        <Modal
          title={"Revoke " + revoking.name + "?"}
          close={() => setRevoking(null)}
        >
          <p>
            This stops new access and cancels pending work. Work you already
            approved may finish.
          </p>
          <Button
            kind="danger"
            busy={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api.request(
                  "/offices/" +
                    encodeURIComponent(office.id) +
                    base +
                    "/connections/" +
                    encodeURIComponent(revoking.id),
                  undefined,
                  "DELETE",
                );
                setRevoking(null);
                await refresh();
              })
            }
          >
            Revoke connection
          </Button>
          <Feedback action={action} />
        </Modal>
      )}
      {selected && (
        <Modal
          title="Review prepared work"
          close={() => {
            setSelected(null);
            setQuote(null);
          }}
        >
          <p>
            From <strong>{selected.connectionName}</strong> ·{" "}
            {selected.chat.model} · up to {selected.chat.maxTokens} output
            tokens
          </p>
          <p className="muted">
            Approving runs this exact request and shares the result with this
            connection.
          </p>
          <pre className="mcp-review-text">
            {selected.chat.messages.map((m) => m.content).join("\n\n")}
          </pre>
          {selected.result?.content && (
            <>
              <h3>Result</h3>
              <pre className="mcp-review-text">{selected.result.content}</pre>
            </>
          )}
          {["pending", "retryable"].includes(selected.status) && (
            <>
              {quote ? (
                <div className="notice">
                  <span>
                    Maximum price:{" "}
                    <strong>{money(quote.maximumUsd, 6)} USD</strong> · expires{" "}
                    {date(quote.expiresAt)}
                  </span>
                </div>
              ) : (
                <p className="muted">
                  Review the complete prompt, then get a price before deciding.
                </p>
              )}
              <div className="mcp-inline">
                {quote ? (
                  <Button
                    busy={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        await api.office(
                          office.id,
                          base + "/requests/" + selected.id + "/approve",
                          { quoteId: quote.id, approved: true },
                        );
                        setSelected(null);
                        setQuote(null);
                        await refresh();
                        action.setNotice(
                          "Request submitted. Refresh to check its result and receipt.",
                        );
                      })
                    }
                  >
                    Approve &amp; run
                  </Button>
                ) : (
                  <Button
                    busy={action.busy}
                    onClick={() =>
                      void action.run(async () =>
                        setQuote(
                          await api.office(
                            office.id,
                            base + "/requests/" + selected.id + "/quote",
                            {},
                          ),
                        ),
                      )
                    }
                  >
                    Review price
                  </Button>
                )}
                <Button
                  kind="secondary"
                  busy={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await api.office(
                        office.id,
                        base + "/requests/" + selected.id + "/reject",
                        {},
                      );
                      setSelected(null);
                      setQuote(null);
                      await refresh();
                    })
                  }
                >
                  Reject request
                </Button>
              </div>
            </>
          )}
          <Feedback action={action} />
        </Modal>
      )}
    </div>
  );
}
