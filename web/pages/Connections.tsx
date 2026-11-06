import { useEffect, useState } from "react";
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
  const [name, setName] = useState("");
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
      <Panel className="card">
        <div className="card-head">
          <div>
            <h2>
              <Plug size={20} /> Connect your AI tools
            </h2>
            <p>
              Use a client that supports Streamable HTTP and a bearer token.
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
                { name, scopes, expiresInDays: days },
              );
              setCreated(result);
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
            Selected data is shared with the AI client using this token. Create
            a separate connection for each client. You may need to sign in again
            before creating one.
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
      <Panel className="card">
        <div className="card-head">
          <div>
            <h2>Your connections</h2>
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
        {!loaded ? (
          <p className="muted">Loading connections…</p>
        ) : !connections.length ? (
          <p className="muted">No AI tools connected yet.</p>
        ) : (
          connections.map((c) => {
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
                </div>
                <div className="mcp-inline">
                  <Pill tone={active ? "green" : "amber"}>
                    {c.revoked_at ? "Revoked" : active ? "Active" : "Expired"}
                  </Pill>
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
            <h2>Prepared work</h2>
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
