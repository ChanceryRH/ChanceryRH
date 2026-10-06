import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  ArrowRight,
  MessageSquare,
  ReceiptText,
  ShieldCheck,
  Users,
  Wallet,
  Sparkles,
} from "lucide-react";
import { useOffice } from "../App";
import {
  api,
  money,
  date,
  short,
  type Receipt,
  type Conversation,
} from "../api";
import { Badge, Button, Feedback, PageTitle, Panel, useAction } from "../ui";
export function Overview() {
  const { office, navigate, config } = useOffice(),
    action = useAction(),
    [receipts, setReceipts] = useState<Receipt[]>([]),
    [conversations, setConversations] = useState<Conversation[]>([]);
  useEffect(() => {
    if (office.status !== "active" || office.role === "guest") return;
    void action.run(async () => {
      const [r, c] = await Promise.all([
        api.office(office.id, "/ledger"),
        api.office(office.id, "/conversations"),
      ]);
      setReceipts(r.slice(0, 5));
      setConversations(c.slice(0, 4));
    });
  }, [office.id, office.status]);
  const percent =
    Number(office.capUsd) > 0
      ? Math.min(100, (Number(office.spentUsd) / Number(office.capUsd)) * 100)
      : 0;
  return (
    <>
      <PageTitle
        eyebrow="YOUR OFFICE, AT A GLANCE"
        title="A little space to do great work."
        actions={
          <Button onClick={() => navigate("chat")}>
            <MessageSquare size={17} />
            Start a conversation
            <ArrowUpRight size={16} />
          </Button>
        }
      >
        Your team’s thinking, spending and decisions. Together.
      </PageTitle>
      <Feedback action={action} />
      <div className="overview-grid">
        <Panel className="budget-card">
          <div className="card-eyebrow">
            <span>
              <Wallet size={17} />
              THE PURSE
            </span>
            <Badge tone={office.status === "active" ? "green" : ""}>
              {office.status}
            </Badge>
          </div>
          <div className="budget-amount">
            {money(office.capUsd)}
            <span>USDG</span>
          </div>
          <p>Your Office’s 30-day spending limit</p>
          <div className="budget-track">
            <i style={{ width: `${percent}%` }} />
          </div>
          <div className="budget-legend">
            <span>
              <i />
              {money(office.spentUsd)} settled this cycle
            </span>
            <span>{percent.toFixed(0)}%</span>
          </div>
          <div className="budget-foot">
            <span>Pending usage also counts toward your limit.</span>
            <button
              onClick={() => navigate("settings")}
              aria-label="Manage Office budget"
            >
              <ArrowUpRight size={18} />
            </button>
          </div>
        </Panel>
        <Panel className="authority-card">
          <div className="card-eyebrow">
            <span>
              <ShieldCheck size={17} />
              YOUR SAFE
            </span>
          </div>
          <h2>
            Your treasury.
            <br /> Your call.
          </h2>
          <div className="safe-address">
            {short(office.safe)}
            <Badge>
              {office.threshold} of {office.owners.length} owners
            </Badge>
          </div>
          <p>Owners approve changes. Members work within the limits.</p>
          <button className="text-button" onClick={() => navigate("proposals")}>
            Review Safe approvals
            <ArrowRight size={15} />
          </button>
        </Panel>
      </div>
      <div className="section-heading">
        <h2>Make room for the work.</h2>
        <span>Your workspace, ready when you are.</span>
      </div>
      <div className="quick-grid">
        {[
          {
            icon: MessageSquare,
            title: "A fresh perspective",
            text: "Pick a model. Ask a question. See the price first.",
            page: "chat",
          },
          {
            icon: Users,
            title: "Good company",
            text: "Invite your people and give everyone the right access.",
            page: "people",
          },
          {
            icon: ReceiptText,
            title: "A clear paper trail",
            text: "Follow every request from the work to the receipt.",
            page: "ledger",
          },
        ].map(({ icon: Icon, title, text, page }) => (
          <button
            className="quick-card"
            key={page}
            onClick={() => navigate(page)}
          >
            <Icon size={23} />
            <h3>{title}</h3>
            <p>{text}</p>
            <ArrowUpRight size={17} />
          </button>
        ))}
      </div>
      <div className="lower-grid">
        <Panel>
          <div className="section-heading">
            <h2>Recent receipts</h2>
            <button onClick={() => navigate("ledger")}>
              View Ledger
              <ArrowUpRight size={14} />
            </button>
          </div>
          {receipts.length ? (
            receipts.map((r) => (
              <div className="activity-row" key={r.id}>
                <span className="activity-icon">
                  <ReceiptText size={17} />
                </span>
                <div>
                  <strong>{r.envelope.payload.model || "Seat charge"}</strong>
                  <small>{date(r.created_at)}</small>
                </div>
                <span>
                  {money(r.envelope.payload.chargedUsd)} <small>USDG</small>
                </span>
              </div>
            ))
          ) : (
            <div className="small-empty">
              <ReceiptText size={25} />
              <p>Your first receipt starts the story.</p>
              <small>Paid requests and seat charges will appear here.</small>
            </div>
          )}
        </Panel>
        <Panel>
          <div className="section-heading">
            <h2>Your conversations</h2>
            <button onClick={() => navigate("chat")}>
              Workspace
              <ArrowUpRight size={14} />
            </button>
          </div>
          {conversations.length ? (
            conversations.map((c) => (
              <button
                className="conversation-preview"
                key={c.id}
                onClick={() => navigate("chat")}
              >
                <MessageSquare size={17} />
                <span>
                  {c.title}
                  <small>{date(c.createdAt)}</small>
                </span>
                <ArrowUpRight size={15} />
              </button>
            ))
          ) : (
            <div className="small-empty">
              <MessageSquare size={25} />
              <p>A blank page. A good place to start.</p>
              <small>Your saved conversations stay in your workspace.</small>
            </div>
          )}
        </Panel>
      </div>
      <div className="update-strip">
        <span className="update-icon">
          <Sparkles size={20} />
        </span>
        <div>
          <strong>Your Office has room to grow.</strong>
          <p>Private Rooms, AI Clerks, signed Minutes and more.</p>
        </div>
        <Button kind="secondary" onClick={() => navigate("updates")}>
          {config.updates.filter((u) => u.enabled).length
            ? "Explore updates"
            : "What’s coming"}
          <ArrowRight size={15} />
        </Button>
      </div>
    </>
  );
}
