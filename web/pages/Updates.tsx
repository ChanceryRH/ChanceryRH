import React, { useEffect, useState } from "react";
import { formatUnits, keccak256, toBytes } from "viem";
import {
  ArrowUpRight,
  BookOpen,
  Bot,
  Columns2,
  FileCheck2,
  FolderLock,
  Gift,
  HandCoins,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Sparkles,
  Ticket,
} from "lucide-react";
import { useOffice } from "../App";
import { api, date, download, money } from "../api";
import { ensureOwner, signInMessage } from "../wallet";
import { checkGuards } from "../../shared/guards";
import {
  Badge,
  Button,
  Empty,
  Feedback,
  Field,
  JsonDetails,
  PageTitle,
  Panel,
  submit,
  useAction,
} from "../ui";
import { Clerks } from "./Clerks";
import { Pill, SidePanel, SideItem, SideSection } from "../shell";
import { Rooms } from "./Rooms";
import { Playbooks } from "./Playbooks";
import { Compare } from "./Compare";
import { GuestPasses } from "./GuestPasses";
import { Reimbursements } from "./Reimbursements";
import { OfficeFiles } from "./OfficeFiles";
const descriptions: Record<string, { icon: typeof Bot; text: string }> = {
  rooms: {
    icon: LockKeyhole,
    text: "Keep sensitive conversations in encrypted spaces, with keys held on members’ devices.",
  },
  clerks: {
    icon: Bot,
    text: "Give recurring work to an assistant with a job, a budget and clear approval rules.",
  },
  safe_drafts: {
    icon: ShieldCheck,
    text: "Review transaction details, simulations and risk flags before Safe owners sign.",
  },
  minutes: {
    icon: FileCheck2,
    text: "Keep important decisions in signed records with verifiable integrity.",
  },
  token_benefits: {
    icon: Gift,
    text: "Eligible Office holdings unlock platform and seat-fee discounts and roadmap voting.",
  },
  playbooks: {
    icon: BookOpen,
    text: "Run approved AI tasks in one click, each with a set model and a fixed price ceiling.",
  },
  side_by_side: {
    icon: Columns2,
    text: "Ask several models the same question and compare answers, prices and receipts.",
  },
  guest_passes: {
    icon: Ticket,
    text: "Give a contractor or advisor time-limited access with its own AI budget.",
  },
  reimbursements: {
    icon: HandCoins,
    text: "Turn a receipt into a payment request your Safe owners can approve and sign.",
  },
  office_files: {
    icon: FolderLock,
    text: "Keep encrypted reference files your team can ask AI about, with answers that cite them.",
  },
};
function Gate({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  const { config, office, navigate } = useOffice();
  const feature = config.updates.find((u) => u.id === id),
    item = descriptions[id];
  const note = (
    <SidePanel title={title}>
      <SideSection>
        <p className="side-note">{item?.text}</p>
      </SideSection>
    </SidePanel>
  );
  if (!feature?.enabled)
    return (
      <>
        {note}
        <div className="coming">
          <span className="coming-icon">
            {item ? <item.icon size={22} /> : <Sparkles size={22} />}
          </span>
          <Pill>Coming next</Pill>
          <h2>{feature?.name || "Not released yet"}</h2>
          <p>{item?.text}</p>
          <p className="muted">
            This update is switched on by your Chancery deployment. It can’t be
            enabled from the dashboard.
          </p>
          <Button kind="secondary" onClick={() => navigate("updates")}>
            See all updates
          </Button>
        </div>
      </>
    );
  if (office.status !== "active")
    return (
      <>
        {note}
        <Empty title="Open your Office first.">
          Updates become available after your Office’s opening approval is
          confirmed.
        </Empty>
      </>
    );
  return <>{children}</>;
}
/* Rooms and Clerks own the side panel, so they live on their own routes. */
const routed: Record<string, string> = {
  rooms: "rooms",
  clerks: "clerks",
  safe_drafts: "clerks?draft",
  playbooks: "playbooks",
  side_by_side: "compare",
  guest_passes: "guests",
  reimbursements: "reimbursements",
  office_files: "files",
};
export function ClerksRoute() {
  return (
    <Gate id="clerks" title="Clerks">
      <Clerks initialDraft={location.hash.includes("draft")} />
    </Gate>
  );
}
export function RoomsRoute() {
  return (
    <Gate id="rooms" title="Rooms">
      <Rooms />
    </Gate>
  );
}
export function PlaybooksRoute() {
  return (
    <Gate id="playbooks" title="Playbooks">
      <Playbooks />
    </Gate>
  );
}
export function CompareRoute() {
  return (
    <Gate id="side_by_side" title="Side by Side">
      <Compare />
    </Gate>
  );
}
export function GuestPassesRoute() {
  return (
    <Gate id="guest_passes" title="Guest Passes">
      <GuestPasses />
    </Gate>
  );
}
export function ReimbursementsRoute() {
  return (
    <Gate id="reimbursements" title="Reimbursements">
      <Reimbursements />
    </Gate>
  );
}
export function OfficeFilesRoute() {
  return (
    <Gate id="office_files" title="Office Files">
      <OfficeFiles />
    </Gate>
  );
}
export function Updates() {
  const { config, office, navigate } = useOffice(),
    [selected, setSelected] = useState("");
  const choose = (id: string) =>
    routed[id] ? navigate(routed[id]) : setSelected(id);
  const feature = config.updates.find((u) => u.id === selected);
  return (
    <>
      <SidePanel title="More">
        <SideSection label="Updates">
          <SideItem
            active={!selected}
            onClick={() => setSelected("")}
            title="Overview"
          />
          {config.updates.map((u) => (
            <SideItem
              key={u.id}
              active={selected === u.id}
              disabled={!u.enabled}
              onClick={() => choose(u.id)}
              title={u.name}
              trailing={
                <Pill tone={u.enabled ? "green" : ""}>
                  {u.enabled ? "On" : "Soon"}
                </Pill>
              }
            />
          ))}
        </SideSection>
      </SidePanel>
      {feature?.enabled ? (
        office.status !== "active" ? (
          <Empty title="Open your Office first.">
            Updates become available after your Office’s opening approval is
            confirmed.
          </Empty>
        ) : selected === "minutes" ? (
          <Minutes />
        ) : (
          <Benefits />
        )
      ) : (
        <>
          <PageTitle title="Updates">
            Explore what’s available for your Office and what’s coming next.
          </PageTitle>
          <div className="updates-grid">
            {config.updates.map((u) => {
              const item = descriptions[u.id],
                Icon = item?.icon || Sparkles;
              return (
                <Panel
                  key={u.id}
                  className={`update-card ${u.enabled ? "enabled" : ""}`}
                >
                  <div className="update-card-top">
                    <span className="update-symbol">
                      <Icon size={18} />
                    </span>
                    <Pill tone={u.enabled ? "green" : ""}>
                      {u.enabled ? "Available" : "Coming next"}
                    </Pill>
                  </div>
                  <h2>{u.name}</h2>
                  <p>{item?.text}</p>
                  <Button
                    kind="secondary"
                    disabled={!u.enabled}
                    onClick={() => choose(u.id)}
                  >
                    {u.enabled ? "Open" : "Not released yet"}
                    {u.enabled && <ArrowUpRight size={15} />}
                  </Button>
                </Panel>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
function Minutes() {
  const { office } = useOffice(),
    action = useAction(),
    [rows, setRows] = useState<any[]>([]),
    [body, setBody] = useState(""),
    [verification, setVerification] = useState<{
      valid: boolean;
      message: string;
    } | null>(null);
  const manager = ["principal", "officer"].includes(office.role);
  async function load() {
    setRows(await api.office(office.id, "/minutes"));
  }
  useEffect(() => {
    void action.run(load);
  }, [office.id]);
  const guard = checkGuards(body);
  return (
    <>
      <PageTitle eyebrow="A RECORD THAT LASTS" title="Put it in the Minutes.">
        Office-visible records, signed by Chancery and queued for an onchain
        hash anchor.
      </PageTitle>
      <Feedback action={action} />
      {manager && (
        <Panel>
          <form
            onSubmit={submit(() =>
              action.run(async () => {
                if (guard) throw new Error(guard.message);
                await api.office(office.id, "/minutes", { body });
                setBody("");
                await load();
                action.setNotice("Minutes issued. The hash anchor is queued.");
              }),
            )}
          >
            <Field label="Record the decision">
              <textarea
                rows={5}
                required
                maxLength={100000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="What did your team decide?"
              />
            </Field>
            {guard && <p className="error-text">{guard.message}</p>}
            <Button
              type="submit"
              busy={action.busy}
              disabled={!!guard || !body.trim()}
            >
              <FileCheck2 size={16} />
              Issue signed Minutes
            </Button>
            <p className="panel-note">
              Encrypted at rest and visible to Office members. This is an issuer
              signature, not a signature from every participant.
            </p>
          </form>
        </Panel>
      )}
      <div className="records-list">
        {rows.map((r) => (
          <Panel key={r.id}>
            <div className="section-heading">
              <small>{date(r.envelope.payload.issuedAt)}</small>
              <Badge>
                {r.transactionHash ? "Anchor submitted" : "Anchor pending"}
              </Badge>
            </div>
            <p className="record-body">{r.body}</p>
            <div className="actions">
              <Button
                kind="ghost"
                onClick={() => download("chancery-minutes.json", r)}
              >
                Download record
              </Button>
              <Button
                kind="secondary"
                onClick={() =>
                  action.run(async () => {
                    const v = await api.request("/verify", {
                      envelope: r.envelope,
                    });
                    const valid =
                      v.valid &&
                      keccak256(toBytes(r.body)) === r.bodyHash &&
                      r.bodyHash === r.envelope.payload.bodyHash;
                    setVerification({
                      valid,
                      message: valid
                        ? `${r.id}: signature and content hash valid`
                        : "The signature or record content could not be verified.",
                    });
                  })
                }
              >
                Verify signature
              </Button>
            </div>
            <JsonDetails
              value={{
                bodyHash: r.bodyHash,
                transactionHash: r.transactionHash,
              }}
            />
          </Panel>
        ))}
      </div>
      {verification && (
        <div
          className={`notice ${verification.valid ? "success" : "error"}`}
          role="status"
        >
          {verification.message}
        </div>
      )}
      {!rows.length && (
        <Empty
          title="Make the important things memorable."
          icon={<FileCheck2 />}
        >
          Your Office’s issued records will appear here.
        </Empty>
      )}
    </>
  );
}
function Benefits() {
  const { office, account, provider, config } = useOffice(),
    action = useAction(),
    [benefits, setBenefits] = useState<any>(null),
    [topic, setTopic] = useState(""),
    [choice, setChoice] = useState("");
  useEffect(() => {
    void action.run(async () =>
      setBenefits(await api.office(office.id, "/benefits")),
    );
  }, [office.id]);
  return (
    <>
      <PageTitle
        eyebrow="A LITTLE MORE FOR YOUR OFFICE"
        title="Benefits that do something."
      >
        Your minimum CCRY holding over a rolling 24-hour window determines your
        Office’s tier.
      </PageTitle>
      <Feedback action={action} />
      {benefits && (
        <>
          {benefits.status !== "verified" && (
            <p className="notice">
              Holding history is unavailable. No discount is applied until
              eligibility can be verified.
            </p>
          )}
          <div className="stats-grid">
            <Panel>
              <span className="eyebrow">YOUR TIER</span>
              <strong>{benefits.tier}</strong>
              <p>Based on the 24-hour minimum</p>
            </Panel>
            <Panel>
              <span className="eyebrow">FEE DISCOUNT</span>
              <strong>{benefits.discountPercent}%</strong>
              <p>Platform and seat fees only</p>
            </Panel>
            <Panel>
              <span className="eyebrow">SAFE HOLDINGS</span>
              <strong className="token-balance">
                {formatUnits(BigInt(benefits.balance), benefits.decimals)}
              </strong>
              <p>
                Eligible holding:{" "}
                {formatUnits(
                  BigInt(benefits.eligibleBalance),
                  benefits.decimals,
                )}{" "}
                CCRY
              </p>
            </Panel>
          </div>
          {benefits.roadmapVote && office.role === "principal" && (
            <Panel>
              <h2>Have a say in what comes next.</h2>
              <form
                onSubmit={submit(() =>
                  action.run(async () => {
                    await ensureOwner(provider, account.wallet);
                    const message = `Chancery roadmap vote\nChain: 4663\nRegistry: ${config.registry}\nOffice: ${office.id}\nTopic: ${topic}\nChoice: ${choice}`;
                    const signature = await signInMessage(
                      provider!,
                      account.wallet as `0x${string}`,
                      message,
                    );
                    await api.office(office.id, "/roadmap-votes", {
                      topic,
                      choice,
                      signature,
                    });
                    action.setNotice(
                      "Your Office’s signed roadmap vote is recorded.",
                    );
                  }),
                )}
              >
                <Field label="Roadmap topic ID">
                  <input
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    pattern="[a-zA-Z0-9_-]{1,80}"
                    required
                  />
                </Field>
                <Field label="Your choice">
                  <input
                    value={choice}
                    onChange={(e) => setChoice(e.target.value)}
                    maxLength={160}
                    required
                  />
                </Field>
                <Button type="submit" busy={action.busy}>
                  Sign Office vote
                </Button>
                <p className="panel-note">
                  One recorded choice per Office and topic. Signing again
                  updates it. This does not execute an onchain governance
                  transaction.
                </p>
              </form>
            </Panel>
          )}
        </>
      )}
    </>
  );
}
