import { useState } from "react";
import { LockKeyhole, ShieldCheck, Wallet } from "lucide-react";
import { useOffice } from "../App";
import { api } from "../api";
import {
  Badge,
  Button,
  Feedback,
  Field,
  Modal,
  PageTitle,
  Panel,
  submit,
  useAction,
} from "../ui";
export function Settings() {
  const { office, onProposal } = useOffice(),
    action = useAction(),
    [cap, setCap] = useState(office.capUsd),
    [maximum, setMaximum] = useState(office.policy.maxRequestUsd),
    [models, setModels] = useState(office.policy.allowedModels.join("\n")),
    [zero, setZero] = useState(
      office.policy.allowedLanes.includes("zero_retention"),
    ),
    [standard, setStandard] = useState(
      office.policy.allowedLanes.includes("standard"),
    ),
    [closing, setClosing] = useState(false),
    [confirmName, setConfirmName] = useState("");
  const editable = office.role === "principal" && office.status === "active";
  return (
    <>
      <PageTitle
        eyebrow="YOUR OFFICE, ON YOUR TERMS"
        title="Clear boundaries. Better work."
      >
        Safe owners approve changes to spending and Office policies.
      </PageTitle>
      <Feedback action={action} />
      <div className="settings-grid">
        <Panel>
          <div className="section-heading">
            <h2>
              <Wallet size={19} />
              Office budget
            </h2>
            <Badge>30-day cycle</Badge>
          </div>
          <form
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
              label="Spending limit · USDG"
              help="This shared cap includes AI usage and seat charges."
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
            <Button type="submit" disabled={!editable} busy={action.busy}>
              Propose budget change
            </Button>
          </form>
          <dl className="detail-list">
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
          </dl>
        </Panel>
        <Panel>
          <div className="section-heading">
            <h2>
              <ShieldCheck size={19} />
              Office rules
            </h2>
            <Badge tone="green">Guards on</Badge>
          </div>
          <form
            onSubmit={submit(() =>
              action.run(async () => {
                await api.office(office.id, "/policy/propose", {
                  mandatoryGuards: true,
                  allowedModels: models
                    .split("\n")
                    .map((x) => x.trim())
                    .filter(Boolean),
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
            <Field
              label="Allowed models"
              help="One model ID per line. Leave empty to allow all available models."
            >
              <textarea
                disabled={!editable}
                value={models}
                onChange={(e) => setModels(e.target.value)}
                rows={4}
              />
            </Field>
            <label className="check-row">
              <input
                type="checkbox"
                disabled={!editable}
                checked={standard}
                onChange={(e) => setStandard(e.target.checked)}
              />
              Standard provider processing
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                disabled={!editable}
                checked={zero}
                onChange={(e) => setZero(e.target.checked)}
              />
              Verified zero-retention models, when available
            </label>
            <Button
              type="submit"
              disabled={!editable || (!standard && !zero)}
              busy={action.busy}
            >
              Propose policy change
            </Button>
          </form>
        </Panel>
      </div>
      <Panel className="close-office">
        <div>
          <h2>Close this Office</h2>
          <p>
            Closure is permanent and stops all spending delegates. Export any
            records you need first.
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
              settlements.
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
