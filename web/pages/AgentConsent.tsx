import { useEffect, useState } from "react";
import { useOffice } from "../App";
import { api, errorText } from "../api";
import { Button, Feedback, Field, Panel, useAction } from "../ui";
import { MCP_SCOPES } from "../../shared/mcp";
export function AgentConsent({ id }: { id: string }) {
  const { office } = useOffice(),
    action = useAction();
  const [request, setRequest] = useState<any>(null),
    [scopes, setScopes] = useState<string[]>([]),
    [days, setDays] = useState(7),
    [budget, setBudget] = useState("25"),
    [maximum, setMaximum] = useState("1");
  useEffect(() => {
    let live = true;
    api
      .office(office.id, "/mcp/oauth/" + encodeURIComponent(id))
      .then((r) => {
        if (live) {
          setRequest(r);
          setScopes(r.scopes);
        }
      })
      .catch((e) => {
        if (live) action.setError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [id, office.id]);
  async function decide(approved: boolean) {
    const result = await api.office(
      office.id,
      "/mcp/oauth/" + encodeURIComponent(id) + "/consent",
      {
        approved,
        scopes,
        expiresInDays: days,
        budgetUsd: budget,
        maxRequestUsd: maximum,
      },
    );
    window.location.assign(result.redirectUri);
  }
  return (
    <Panel className="card">
      <h2>Connect with consent</h2>
      <Feedback action={action} />
      {request && (
        <>
          <p>
            <strong>{request.name}</strong> is asking to connect to{" "}
            <strong>{office.name}</strong>.
          </p>
          <div className="notice">
            <span>
              Client names are self-declared. Continue only if you started this
              connection and recognize its callback address.
            </span>
          </div>
          <Field label="Return address">
            <input readOnly value={request.redirectUri} />
          </Field>
          <fieldset className="mcp-permissions">
            <legend>Permissions you grant</legend>
            {request.scopes.map((scope: string) => {
              const s = MCP_SCOPES.find((s) => s.id === scope);
              return (
                <label className="mcp-permission" key={scope}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(e) =>
                      setScopes((old) =>
                        e.target.checked
                          ? [...old, scope]
                          : old.filter((s) => s !== scope),
                      )
                    }
                  />
                  <span>
                    <strong>{s?.name}</strong>
                    <small>{s?.detail}</small>
                  </span>
                </label>
              );
            })}
          </fieldset>
          <div className="mcp-form-grid">
            <Field label="Rolling 24-hour budget · USD">
              <input
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                inputMode="decimal"
              />
            </Field>
            <Field label="Maximum per request · USD">
              <input
                value={maximum}
                onChange={(e) => setMaximum(e.target.value)}
                inputMode="decimal"
              />
            </Field>
            <Field label="Connection expires">
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                <option value={1}>After 1 day</option>
                <option value={7}>After 7 days</option>
                <option value={30}>After 30 days</option>
              </select>
            </Field>
          </div>
          <p>
            AI work still needs your approval. You can pause or revoke this
            connection in Agents.
          </p>
          <div className="mcp-inline">
            <Button
              busy={action.busy}
              disabled={!scopes.length}
              onClick={() => void action.run(() => decide(true))}
            >
              Allow selected access
            </Button>
            <Button
              kind="secondary"
              busy={action.busy}
              onClick={() => void action.run(() => decide(false))}
            >
              Deny
            </Button>
          </div>
        </>
      )}
    </Panel>
  );
}
