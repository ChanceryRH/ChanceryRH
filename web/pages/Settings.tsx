import { Connections } from "./Connections";
import { useState } from "react";
import { Info } from "lucide-react";
import { useOffice } from "../App";
import { api, money, short } from "../api";
import {
  Button,
  Feedback,
  Field,
  Modal,
  Panel,
  submit,
  useAction,
} from "../ui";
import { Pill, Progress, SidePanel, SideItem, SideSection } from "../shell";

const sections = [
  ["budget", "Allowance & caps"],
  ["models", "Models & privacy"],
  ["safe", "Safe"],
  ["connections", "AI connections"],
  ["danger", "Close Office"],
] as const;

export function Settings() {
  const { office, onProposal, models, config } = useOffice(),
    action = useAction(),
    [section, setSection] = useState<(typeof sections)[number][0]>("budget"),
    [cap, setCap] = useState(office.capUsd),
    [maximum, setMaximum] = useState(office.policy.maxRequestUsd),
    [allowed, setAllowed] = useState<string[]>(office.policy.allowedModels),
    [zero, setZero] = useState(
      office.policy.allowedLanes.includes("zero_retention"),
    ),
    [standard, setStandard] = useState(
      office.policy.allowedLanes.includes("standard"),
    ),
    [closing, setClosing] = useState(false),
    [confirmName, setConfirmName] = useState("");
  const editable = office.role === "principal" && office.status === "active";
  /* An empty allowlist means every priced model is allowed. */
  const catalog = [
    ...models.map((m) => ({ id: m.id, name: m.name })),
    ...office.policy.allowedModels
      .filter((id) => !models.some((m) => m.id === id))
      .map((id) => ({ id, name: id })),
  ];
  const allowAll = allowed.length === 0;
  const isOn = (id: string) => allowAll || allowed.includes(id);
  function toggle(id: string) {
    const current = allowAll ? catalog.map((m) => m.id) : allowed;
    const next = current.includes(id)
      ? current.filter((x) => x !== id)
      : [...current, id];
    setAllowed(next.length === catalog.length ? [] : next);
  }
  const policyChanged =
    maximum !== office.policy.maxRequestUsd ||
    [...allowed].sort().join() !==
      [...office.policy.allowedModels].sort().join() ||
    standard !== office.policy.allowedLanes.includes("standard") ||
    zero !== office.policy.allowedLanes.includes("zero_retention");
  const capNum = Number(office.capUsd) || 0,
    spent = Number(office.spentUsd) || 0;
  return (
    <>
      <SidePanel title="Settings">
        <SideSection>
          {sections
            .filter(
              ([id]) =>
                id !== "connections" ||
                config.updates.some((u) => u.id === "mcp" && u.enabled),
            )
            .map(([id, label]) => (
              <SideItem
                key={id}
                active={section === id}
                title={label}
                onClick={() => setSection(id)}
              />
            ))}
        </SideSection>
      </SidePanel>
      <header className="page-head">
        <div>
          <h1>{sections.find((s) => s[0] === section)![1]}</h1>
          <p>
            {section === "budget"
              ? "The Office allowance shared by seats and Clerks."
              : section === "models"
                ? "Which models your Office may use, and how requests are processed."
                : section === "connections"
                  ? "Connect your AI tools with scoped access and human approval."
                  : section === "safe"
                    ? "The Safe that funds and governs this Office."
                    : "Permanently close this Office."}
          </p>
        </div>
      </header>
      {section !== "connections" && (
        <div className="notice">
          <Info size={16} />
          <span>
            Every change here becomes a Safe proposal and needs{" "}
            {office.owners.length === 1
              ? "its owner’s signature."
              : `${office.threshold} of ${office.owners.length} owner signatures.`}
            {!editable &&
              " Only Safe owners can propose changes while the Office is active."}
          </span>
        </div>
      )}
      <Feedback action={action} />
      {section === "connections" && <Connections key={office.id} />}
      {section === "budget" && (
        <>
          <Panel className="card">
            <div className="card-head">
              <div>
                <h2>Current Office allowance</h2>
                <p>Includes AI usage and seat fees · 30-day cycle</p>
              </div>
              <div className="card-figure">
                <strong>{money(capNum)} USDG</strong>
                <small>
                  {money(spent)} spent · {money(Math.max(0, capNum - spent))}{" "}
                  available
                </small>
              </div>
            </div>
            <Progress value={spent} max={capNum} />
          </Panel>
          <Panel className="card">
            <form
              className="inline-form"
              onSubmit={submit(() =>
                action.run(async () => {
                  await api.office(office.id, "/cap/propose", {
                    monthlyCap: cap,
                  });
                  await onProposal();
                }),
              )}
            >
              <Field
                label="New allowance · USDG per 30 days"
                help="Maximum 5,000 USDG."
              >
                <input
                  disabled={!editable}
                  type="number"
                  required
                  min="0"
                  max="5000"
                  step="0.01"
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                />
              </Field>
              <Button
                type="submit"
                disabled={!editable || cap === office.capUsd}
                busy={action.busy}
              >
                Propose change
              </Button>
            </form>
          </Panel>
        </>
      )}
      {section === "models" && (
        <form
          onSubmit={submit(() =>
            action.run(async () => {
              await api.office(office.id, "/policy/propose", {
                mandatoryGuards: true,
                allowedModels: allowed,
                allowedLanes: [
                  ...(standard ? ["standard"] : []),
                  ...(zero ? ["zero_retention"] : []),
                ],
                maxRequestUsd: maximum,
              });
              await onProposal();
            }),
          )}
        >
          <Panel className="card">
            <div className="card-head">
              <div>
                <h2>Model allowlist</h2>
                <p>
                  {allowAll
                    ? "All priced models are allowed, including ones added later."
                    : `${allowed.length} of ${catalog.length} models allowed.`}
                </p>
              </div>
              {!allowAll && editable && (
                <button
                  type="button"
                  className="link"
                  onClick={() => setAllowed([])}
                >
                  Allow all
                </button>
              )}
            </div>
            {catalog.length ? (
              <div className="toggle-list">
                {catalog.map((m) => (
                  <label key={m.id} className="toggle-row">
                    <span>
                      {m.name}
                      <small>{m.id}</small>
                    </span>
                    <Pill tone={isOn(m.id) ? "green" : ""}>
                      {isOn(m.id) ? "Allowed" : "Off"}
                    </Pill>
                    <span className="switch">
                      <input
                        type="checkbox"
                        disabled={!editable}
                        checked={isOn(m.id)}
                        onChange={() => toggle(m.id)}
                      />
                      <span aria-hidden="true" />
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="card-empty">
                The model catalog is unavailable. Refresh the Office and try
                again.
              </p>
            )}
          </Panel>
          <Panel className="card">
            <div className="card-head">
              <div>
                <h2>Request rules</h2>
                <p>Guards always run before a request leaves the browser.</p>
              </div>
              <Pill tone="green">Guards on</Pill>
            </div>
            <Field label="Maximum price per AI request · USDG">
              <input
                type="number"
                required
                min="0.000001"
                max="20"
                step="0.000001"
                disabled={!editable}
                value={maximum}
                onChange={(e) => setMaximum(e.target.value)}
              />
            </Field>
            <div className="toggle-list">
              <label className="toggle-row">
                <span>
                  Standard provider processing
                  <small>Messages are sent to the chosen provider.</small>
                </span>
                <span className="switch">
                  <input
                    type="checkbox"
                    disabled={!editable}
                    checked={standard}
                    onChange={(e) => setStandard(e.target.checked)}
                  />
                  <span aria-hidden="true" />
                </span>
              </label>
              <label className="toggle-row">
                <span>
                  Verified zero-retention models
                  <small>When available. Response content is not stored.</small>
                </span>
                <span className="switch">
                  <input
                    type="checkbox"
                    disabled={!editable}
                    checked={zero}
                    onChange={(e) => setZero(e.target.checked)}
                  />
                  <span aria-hidden="true" />
                </span>
              </label>
            </div>
          </Panel>
          <div className="action-bar">
            <span className="muted">
              {policyChanged
                ? "Unsaved changes become a Safe proposal."
                : "No changes."}
            </span>
            <Button
              type="submit"
              disabled={!editable || !policyChanged || (!standard && !zero)}
              busy={action.busy}
            >
              Propose policy change
            </Button>
          </div>
        </form>
      )}
      {section === "safe" && (
        <Panel className="card">
          {editable && (
            <div className="notice">
              <p>
                Restore the Office allowance if an external wallet change put
                its period out of sync. Safe owner signatures are required.
              </p>
              <Button
                kind="secondary"
                busy={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await api.office(office.id, "/allowance/resync", {});
                    await onProposal();
                  })
                }
              >
                Prepare allowance recovery
              </Button>
            </div>
          )}
          <dl className="kv">
            <div>
              <dt>Safe</dt>
              <dd>
                <code>{office.safe}</code>
              </dd>
            </div>
            <div>
              <dt>Allowance delegate</dt>
              <dd>
                <code>{office.delegate}</code>
              </dd>
            </div>
            <div>
              <dt>Approval threshold</dt>
              <dd>
                {office.threshold} of {office.owners.length} owners
              </dd>
            </div>
            <div>
              <dt>Owners</dt>
              <dd className="owner-list">
                {office.owners.map((o) => (
                  <code key={o} title={o}>
                    {short(o)}
                  </code>
                ))}
              </dd>
            </div>
            <div>
              <dt>Allowance module</dt>
              <dd>
                <Pill tone={office.moduleEnabled ? "green" : "amber"}>
                  {office.moduleEnabled ? "Enabled" : "Needs attention"}
                </Pill>
              </dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>Robinhood Chain · 4663</dd>
            </div>
          </dl>
        </Panel>
      )}
      {section === "danger" && (
        <Panel className="card danger-card">
          <div>
            <h2>Close this Office</h2>
            <p>
              This Safe cannot open another Office in this Registry after
              closure. Closure stops all spending delegates. Export any records
              you need first.
            </p>
          </div>
          <Button
            kind="danger"
            disabled={!editable}
            onClick={() => setClosing(true)}
          >
            Close Office
          </Button>
        </Panel>
      )}
      {closing && (
        <Modal
          title="Close this Office permanently?"
          close={() => setClosing(false)}
        >
          <form
            onSubmit={submit(() =>
              action.run(async () => {
                await api.office(office.id, "/close/propose", {});
                setClosing(false);
                await onProposal();
              }),
            )}
          >
            <p className="muted">
              This prepares a Safe proposal. Closing becomes permanent when the
              owners execute it, and stops collection of outstanding
              settlements. The same Safe cannot reopen an Office in this
              Registry.
            </p>
            <Field label={`Type “${office.name}” to continue`}>
              <input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Feedback action={action} />
            <Button
              kind="danger"
              type="submit"
              disabled={confirmName !== office.name}
              busy={action.busy}
            >
              Prepare permanent closure
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
