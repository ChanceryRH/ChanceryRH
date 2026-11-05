import React, { useEffect, useState } from "react";
import { formatUnits, keccak256, toBytes } from "viem";
import {
  ArrowUpRight,
  Bot,
  FileCheck2,
  Gift,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Sparkles,
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
            Five additions to the Office. Your deployment decides which are on.
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
        Live token holdings in your Safe determine your Office’s tier.
      </PageTitle>
      <Feedback action={action} />
      {benefits && (
        <>
          <div className="stats-grid">
            <Panel>
              <span className="eyebrow">YOUR TIER</span>
              <strong>{benefits.tier}</strong>
              <p>Based on current Safe holdings</p>
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
              <p>Provider inference costs remain unchanged</p>
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
