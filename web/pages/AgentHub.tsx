import { useOffice } from "../App";
import { AgentConsent } from "./AgentConsent";
import { Connections } from "./Connections";
import { SidePanel, SideSection, SideItem } from "../shell";
import "../agent-hub.css";
export function Agents() {
  const { config, office } = useOffice();
  if (!config.updates.some((u) => u.id === "mcp" && u.enabled))
    return <p>Agents is unavailable.</p>;
  const connect = new URLSearchParams(location.hash.split("?")[1] || "").get(
    "connect",
  );
  const target = new URLSearchParams(location.hash.split("?")[1] || "").get(
    "office",
  );
  return (
    <>
      <SidePanel title="Chancery Agents">
        <SideSection>
          <SideItem title="My agents" active onClick={() => {}} />
          <p className="muted">Your tools. Your permissions. Your call.</p>
        </SideSection>
      </SidePanel>
      <header className="page-head">
        <div>
          <h1>Chancery Agents</h1>
          <p>Connect your tools. Set their limits. Stay in control.</p>
        </div>
      </header>
      {target && target !== office.id ? (
        <div className="notice">
          This approval belongs to another Office. Select that Office using the
          Office switcher to continue.
        </div>
      ) : connect ? (
        <AgentConsent key={office.id + connect} id={connect} />
      ) : (
        <Connections key={office.id} />
      )}
    </>
  );
}
