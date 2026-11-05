import { flushSync } from "react-dom";
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  startAuthentication,
  startRegistration,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
import {
  ArrowUpRight,
  AudioLines,
  Building2,
  ChevronDown,
  CircleCheck,
  Fingerprint,
  House,
  LockKeyhole,
  LogOut,
  Monitor,
  Moon,
  Sun,
  PanelLeft,
  MessageSquare,
  Plus,
  ReceiptText,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sparkle,
  Sparkles,
  Users,
  Wallet as WalletIcon,
} from "lucide-react";
import {
  api,
  ChanceryError,
  errorText,
  short,
  type Account,
  type AppConfig,
  type Office,
  type Model,
} from "./api";
import {
  connect,
  discoverWallets,
  watchWallets,
  signInMessage,
  type WalletProvider,
} from "./wallet";
import {
  Badge,
  Button,
  Empty,
  Feedback,
  Field,
  Modal,
  PageTitle,
  Panel,
  submit,
  useAction,
} from "./ui";
import { Overview } from "./pages/Overview";
import {
  resolvedTheme,
  saveTheme,
  storedTheme,
  watchSystemTheme,
  type Theme,
} from "./theme";
import { Ledger } from "./pages/Ledger";
import { People } from "./pages/People";
import { Proposals } from "./pages/Proposals";
import { Settings as SettingsPage } from "./pages/Settings";
import {
  AllowanceFooter,
  avatarStyle,
  CommandMenu,
  PanelHostProvider,
  type Command,
} from "./shell";
const Chat = lazy(() =>
  import("./pages/Chat").then((module) => ({ default: module.Chat })),
);
const Updates = lazy(() =>
  import("./pages/Updates").then((module) => ({ default: module.Updates })),
);
const ClerksPage = lazy(() =>
  import("./pages/Updates").then((module) => ({ default: module.ClerksRoute })),
);
const RoomsPage = lazy(() =>
  import("./pages/Updates").then((module) => ({ default: module.RoomsRoute })),
);
export type Context = {
  account: Account;
  config: AppConfig;
  office: Office;
  models: Model[];
  provider: WalletProvider | null;
  refresh: () => Promise<void>;
  navigate: (page: string) => void;
  onProposal: () => Promise<void>;
  newChat: () => void;
  pendingApprovals: number;
  reloadApprovals: () => Promise<void>;
};
export const OfficeContext = createContext<Context | null>(null);
export const useOffice = () => useContext(OfficeContext)!;
const routes = [
  ["overview", "Home", House],
  ["chat", "Workspace", MessageSquare],
  ["proposals", "Approvals", CircleCheck],
  ["ledger", "Ledger", ReceiptText],
  ["people", "People", Users],
  ["clerks", "Clerks", Sparkle],
  ["rooms", "Rooms", LockKeyhole],
  ["updates", "More", Sparkles],
  ["settings", "Settings", Settings],
] as const;
const pageFromHash = () => {
  const value = location.hash.replace(/^#\/?/, "").split("?")[0];
  return routes.some((r) => r[0] === value) ? value : "overview";
};
export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null),
    [account, setAccount] = useState<Account | null>(null),
    [loading, setLoading] = useState(true),
    [fatal, setFatal] = useState("");
  const [offices, setOffices] = useState<Office[]>([]),
    [office, setOffice] = useState<Office | null>(null),
    [models, setModels] = useState<Model[]>([]),
    [provider, setProvider] = useState<WalletProvider | null>(null),
    [page, setPage] = useState(pageFromHash),
    [mobile, setMobile] = useState(false),
    [picker, setPicker] = useState(false),
    [creation, setCreation] = useState(false),
    [joining, setJoining] = useState(false),
    [selected, setSelected] = useState(""),
    [chatKey, setChatKey] = useState(0),
    [pendingApprovals, setPendingApprovals] = useState(0),
    [accountMenu, setAccountMenu] = useState(false),
    [panelHost, setPanelHost] = useState<HTMLElement | null>(null),
    [theme, setThemeState] = useState<Theme>(storedTheme),
    [, setSystemTick] = useState(0);
  const action = useAction();
  const dark = resolvedTheme(theme) === "dark";
  /* Switching light/dark reveals the new theme as a circle growing from
     the control that was pressed. Falls back to an instant swap. */
  function setTheme(next: Theme, from?: Element | null) {
    const apply = () => {
      saveTheme(next);
      flushSync(() => setThemeState(next));
    };
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => { ready: Promise<void> };
    };
    if (
      !doc.startViewTransition ||
      resolvedTheme(next) === resolvedTheme(theme) ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return apply();
    const box = from?.getBoundingClientRect();
    const x = box ? box.left + box.width / 2 : innerWidth / 2,
      y = box ? box.top + box.height / 2 : 0;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    doc
      .startViewTransition(apply)
      .ready.then(() =>
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
          { duration: 560, easing: "cubic-bezier(.22,.8,.24,1)", pseudoElement: "::view-transition-new(root)" },
        ),
      )
      .catch(() => {});
  }
  /* Re-render when the OS appearance changes while following the system. */
  useEffect(() => watchSystemTheme(() => setSystemTick((n) => n + 1)), []);
  const current = useRef({ accountId: account?.id, selected });
  current.current = { accountId: account?.id, selected };
  /* On narrow screens the panel is a drawer; close it once an item is chosen.
     Panel content is portaled in, so listen on the DOM node itself. */
  useEffect(() => {
    if (!panelHost) return;
    const close = (e: MouseEvent) => {
      if ((e.target as Element).closest(".side-item")) setMobile(false);
    };
    panelHost.addEventListener("click", close);
    return () => panelHost.removeEventListener("click", close);
  }, [panelHost]);
  function navigate(next: string) {
    location.hash = `/${next}`;
    setPage(next);
    setMobile(false);
  }
  useEffect(() => {
    const fn = () => setPage(pageFromHash());
    window.addEventListener("hashchange", fn);
    return () => window.removeEventListener("hashchange", fn);
  }, []);
  async function boot() {
    setLoading(true);
    setFatal("");
    try {
      const [cfg, session] = await Promise.all([
        api.request<AppConfig>("/config"),
        api.session().catch((error) => {
          if (error instanceof ChanceryError && error.status === 401)
            return null;
          throw error;
        }),
      ]);
      setConfig(cfg);
      setAccount(session?.account || null);
    } catch (e) {
      setFatal(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void boot();
  }, []);
  useEffect(() => {
    api.onSessionExpired = () => {
      setAccount(null);
      setProvider(null);
    };
    return () => {
      api.onSessionExpired = undefined;
    };
  }, []);
  async function loadOffices(preferred?: string) {
    const owner = account?.id;
    const rows = await api.request<Office[]>("/offices");
    if (current.current.accountId !== owner) return;
    setOffices(rows);
    const id = preferred || current.current.selected;
    const choice = rows.find((o) => o.id === id) || rows[0];
    setSelected(choice?.id || "");
    if (!choice) setOffice(null);
    return choice?.id;
  }
  useEffect(() => {
    if (!account) {
      setOffices([]);
      setOffice(null);
      setModels([]);
      setSelected("");
      return;
    }
    let active = true;
    void Promise.all([
      api.request<Office[]>("/offices"),
      api.request<Model[]>("/models").catch(() => []),
    ])
      .then(([rows, catalog]) => {
        if (!active) return;
        setOffices(rows);
        setSelected(rows[0]?.id || "");
        setModels(catalog);
      })
      .catch((e) => {
        if (active) action.setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [account?.id]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setOffice(null);
    void api
      .office(selected)
      .then((data) => {
        if (active) setOffice(data);
      })
      .catch((e) => {
        if (active) action.setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [selected, account?.id]);
  async function reloadApprovals() {
    if (!office || office.role !== "principal") {
      setPendingApprovals(0);
      return;
    }
    const id = office.id;
    const rows = await api
      .office(id, "/proposals")
      .catch(() => [] as any[]);
    if (current.current.selected === id)
      setPendingApprovals(
        rows.filter((r: any) => r.status === "pending").length,
      );
  }
  useEffect(() => {
    void reloadApprovals();
  }, [office?.id, office?.role, office?.status]);
  async function refresh() {
    if (!account) return;
    const owner = account.id;
    const id = await loadOffices();
    if (id) {
      const latest = await api.office(id);
      if (
        current.current.accountId === owner &&
        current.current.selected === id
      )
        setOffice(latest);
    }
    const catalog = await api.request("/models").catch(() => models);
    if (current.current.accountId === owner) setModels(catalog);
  }
  async function signedIn(a: Account) {
    setAccount(a);
    navigate("overview");
  }
  const context =
    account && office && config
      ? {
          account,
          config,
          office,
          models,
          provider,
          refresh,
          navigate,
          newChat: () => {
            setChatKey((k) => k + 1);
            navigate("chat");
          },
          pendingApprovals,
          reloadApprovals,
          onProposal: async () => {
            await refresh();
            await reloadApprovals();
            navigate("proposals");
          },
        }
      : null;
  const commands: Command[] = context
    ? [
        ...routes.map(([id, label]) => ({
          id: `go:${id}`,
          label: `Go to ${label}`,
          hint: "Page",
          run: () => navigate(id),
        })),
        { id: "new-chat", label: "New chat", hint: "Action", run: context.newChat },
        ...(office?.role === "principal" || office?.role === "officer"
          ? [{ id: "invite", label: "Invite a teammate", hint: "People", run: () => { location.hash = "/people?invite"; setPage("people"); } }]
          : []),
        { id: "export", label: "Export this month’s ledger", hint: "Ledger", run: () => navigate("ledger") },
        { id: "refresh", label: "Refresh Office", hint: "Action", run: () => void action.run(refresh) },
        { id: "theme-dark", label: "Use dark theme", hint: "Appearance", run: () => setTheme("dark") },
        { id: "theme-light", label: "Use light theme", hint: "Appearance", run: () => setTheme("light") },
        { id: "theme-system", label: "Match system appearance", hint: "Appearance", run: () => setTheme("system") },
      ]
    : [];
  const showRail = !!context;
  return (
    <div className={`app-shell ${showRail ? "" : "bare"} ${mobile ? "side-open" : ""}`}>
      {showRail && (
        <nav className="rail" aria-label="Main navigation">
          <a href="/" className="rail-mark" aria-label="Chancery home">
            <img src="/app/brand/mark-ink.svg" alt="" />
          </a>
          <div className="rail-items">
            {routes.map(([id, label, Icon]) => (
              <button
                key={id}
                className={`rail-item ${page === id ? "active" : ""} ${id === "settings" ? "pinned" : ""}`}
                onClick={() => navigate(id)}
                aria-current={page === id ? "page" : undefined}
                aria-label={label}
                data-tip={label}
              >
                <Icon size={20} strokeWidth={1.75} />
                {id === "proposals" && pendingApprovals > 0 && (
                  <span className="rail-badge">{pendingApprovals}</span>
                )}
              </button>
            ))}
          </div>
          <div className="rail-account">
            <button
              className={`rail-avatar ${account?.wallet ? "tinted" : ""}`}
              style={account?.wallet ? avatarStyle(account.wallet) : undefined}
              aria-label="Account"
              aria-expanded={accountMenu}
              onClick={() => setAccountMenu(!accountMenu)}
            >
              {account?.wallet ? account.wallet.slice(2, 4).toUpperCase() : <Fingerprint size={16} />}
            </button>
            {accountMenu && account && (
              <div className="popover account-popover">
                <strong>{account.wallet ? short(account.wallet) : "Passkey member"}</strong>
                <small>{office ? `${office.role} · ${office.name}` : "Signed in"}</small>
                <div className="theme-choice" role="radiogroup" aria-label="Appearance">
                  {(
                    [
                      ["system", "System", Monitor],
                      ["light", "Light", Sun],
                      ["dark", "Dark", Moon],
                    ] as const
                  ).map(([id, label, Icon]) => (
                    <button
                      key={id}
                      role="radio"
                      aria-checked={theme === id}
                      className={theme === id ? "active" : ""}
                      onClick={(e) => setTheme(id, e.currentTarget)}
                    >
                      <Icon size={13} />
                      {label}
                    </button>
                  ))}
                </div>
                <a href="/" className="popover-link">
                  About Chancery <ArrowUpRight size={13} />
                </a>
                <button
                  className="popover-link"
                  onClick={() =>
                    action.run(async () => {
                      setAccountMenu(false);
                      await api.logout();
                      api.csrfToken = null;
                      setAccount(null);
                      setProvider(null);
                    })
                  }
                >
                  <LogOut size={14} /> Sign out
                </button>
              </div>
            )}
          </div>
        </nav>
      )}
      <div className="app-frame">
        <header className="topbar">
          {showRail ? (
            <button
              className="icon-button side-toggle"
              aria-label="Toggle page panel"
              onClick={() => setMobile(!mobile)}
            >
              <PanelLeft size={18} />
            </button>
          ) : (
            <a href="/" className="bare-brand">
              <img src="/app/brand/mark-ink.svg" alt="" />
              <span>Chancery</span>
            </a>
          )}
          {account && (
            <div className="office-switcher">
              <button
                className="switcher-button"
                onClick={() => setPicker(!picker)}
                aria-expanded={picker}
              >
                <span className="switcher-mark">
                  {office?.name.slice(0, 1) || <Building2 size={14} />}
                </span>
                <span className="switcher-name">{office?.name || "Choose an Office"}</span>
                <ChevronDown size={15} />
              </button>
              {picker && (
                <div className="popover office-menu">
                  {offices.map((o) => (
                    <button
                      key={o.id}
                      className={o.id === selected ? "active" : ""}
                      onClick={() => {
                        setSelected(o.id);
                        setPicker(false);
                        navigate("overview");
                      }}
                    >
                      <span>{o.name}</span>
                      <small>{o.status}</small>
                    </button>
                  ))}
                  <hr />
                  <button
                    onClick={() => {
                      setCreation(true);
                      setPicker(false);
                    }}
                  >
                    <Plus size={14} /> Open an Office
                  </button>
                  <button
                    onClick={() => {
                      setJoining(true);
                      setPicker(false);
                    }}
                  >
                    <Users size={14} /> Join an Office
                  </button>
                </div>
              )}
            </div>
          )}
          {context && <CommandMenu commands={commands} />}
          <div className="topbar-right">
            <span className="network-pill" title="Robinhood Chain · 4663">
              <i />
              Robinhood Chain
            </span>
            {account?.wallet && !provider && (
              <Button
                kind="secondary"
                onClick={() =>
                  action.run(async () => {
                    const wallet = discoverWallets()[0];
                    if (!wallet)
                      throw new Error(
                        "Open Chancery in a browser with your wallet installed.",
                      );
                    const address = await connect(wallet.provider);
                    if (address.toLowerCase() !== account.wallet!.toLowerCase())
                      throw new Error(
                        "Connect the wallet used for this session.",
                      );
                    setProvider(wallet.provider);
                  })
                }
              >
                <WalletIcon size={15} />
                <span className="hide-sm">Connect wallet</span>
              </Button>
            )}
            <button
              className="icon-button"
              aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
              title={dark ? "Light theme" : "Dark theme"}
              onClick={(e) => setTheme(dark ? "light" : "dark", e.currentTarget)}
            >
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            {account && (
              <button
                className="icon-button"
                aria-label="Refresh Office"
                title="Refresh Office"
                onClick={() => action.run(async () => { await refresh(); await reloadApprovals(); })}
                disabled={action.busy}
              >
                <RefreshCw size={16} className={action.busy ? "spin" : ""} />
              </button>
            )}
            {context && (
              <Button onClick={context.newChat} disabled={office?.role === "guest"}>
                <MessageSquare size={15} />
                New chat
              </Button>
            )}
          </div>
        </header>
        <div className="workspace">
          {showRail && (
            <aside className="side" aria-label="Page panel">
              <div className="side-host" ref={setPanelHost} />
              {office && (
                <AllowanceFooter
                  name={office.name}
                  capUsd={office.capUsd}
                  spentUsd={office.spentUsd}
                />
              )}
            </aside>
          )}
          {mobile && (
            <button
              className="side-scrim"
              aria-label="Close page panel"
              onClick={() => setMobile(false)}
            />
          )}
          <main className="main">
            <Feedback action={action} />
            {loading ? (
              <div className="loading">
                <AudioLines className="pulse" />
                <p>Opening your workspace…</p>
              </div>
            ) : fatal ? (
              <Empty
                title="Let’s reconnect."
                action={<Button onClick={boot}>Try again</Button>}
              >
                {fatal}
              </Empty>
            ) : !account && config ? (
              <Welcome
                config={config}
                signedIn={signedIn}
                setProvider={setProvider}
              />
            ) : account && config && !selected ? (
              <div className="start">
                <PageTitle title="Start your Office">
                  Open an Office for your team from an existing Safe, or join one
                  you’ve been invited to.
                </PageTitle>
                <div className="start-grid">
                  <Panel>
                    <Building2 size={22} />
                    <h2>Open an Office</h2>
                    <p>
                      Connect an existing Safe, choose a budget and invite your
                      team.
                    </p>
                    <Button
                      onClick={() => setCreation(true)}
                      disabled={!account.wallet || !config.registry}
                    >
                      Open an Office
                      <Plus size={15} />
                    </Button>
                    {!account.wallet && (
                      <small>
                        Sign in with a Safe owner wallet to open an Office.
                      </small>
                    )}
                    {!config.registry && (
                      <small>
                        Office creation will be available when network setup is
                        complete.
                      </small>
                    )}
                  </Panel>
                  <Panel>
                    <Users size={22} />
                    <h2>Join an Office</h2>
                    <p>
                      Have an invitation? Join with your wallet or passkey. Your
                      Safe owners approve access.
                    </p>
                    <Button kind="secondary" onClick={() => setJoining(true)}>
                      Join an Office
                      <ArrowUpRight size={15} />
                    </Button>
                  </Panel>
                </div>
              </div>
            ) : context ? (
              <OfficeContext.Provider value={context}>
                <PanelHostProvider value={panelHost}>
                  <Suspense
                    fallback={<div className="loading">Opening your workspace…</div>}
                  >
                    {/* Keyed by page too, so every navigation replays the entrance. */}
                    <div key={`${account!.id}:${office!.id}:${page}`} className="page">
                      <OfficeState office={office!} navigate={navigate} />
                      {page === "overview" ? (
                        <Overview />
                      ) : page === "chat" ? (
                        <Chat key={chatKey} />
                      ) : page === "ledger" ? (
                        <Ledger />
                      ) : page === "people" ? (
                        <People />
                      ) : page === "proposals" ? (
                        <Proposals />
                      ) : page === "settings" ? (
                        <SettingsPage />
                      ) : page === "clerks" ? (
                        <ClerksPage />
                      ) : page === "rooms" ? (
                        <RoomsPage />
                      ) : (
                        <Updates />
                      )}
                    </div>
                  </Suspense>
                </PanelHostProvider>
              </OfficeContext.Provider>
            ) : (
              <div className="loading">
                <RefreshCw className="spin" />
                <p>Loading your Office…</p>
              </div>
            )}
          </main>
        </div>
      </div>
      {creation && config && account && (
        <CreateOffice
          config={config}
          close={() => setCreation(false)}
          created={async (id) => {
            setCreation(false);
            await loadOffices(id);
            navigate("proposals");
          }}
        />
      )}
      {joining && (
        <JoinOffice close={() => setJoining(false)} joined={refresh} />
      )}
    </div>
  );
}
function OfficeState({
  office,
  navigate,
}: {
  office: Office;
  navigate: (p: string) => void;
}) {
  if (
    office.status === "active" &&
    office.seatStatus === "active" &&
    office.moduleEnabled
  )
    return null;
  return (
    <div className="notice warning">
      <ShieldCheck size={18} />
      <span>
        {office.status === "pending"
          ? "Your Office is awaiting Safe approval."
          : office.status === "closed"
            ? "This Office has been closed."
            : office.seatStatus !== "active"
              ? "Your seat is awaiting Safe approval."
              : "Your Safe’s allowance needs attention before paid work can resume."}
      </span>
      {office.role === "principal" && (
        <button onClick={() => navigate("proposals")}>
          Review approvals →
        </button>
      )}
    </div>
  );
}
function Welcome({
  config,
  signedIn,
  setProvider,
}: {
  config: AppConfig;
  signedIn: (a: Account) => void;
  setProvider: (p: WalletProvider) => void;
}) {
  const action = useAction(),
    [wallets, setWallets] = useState(discoverWallets),
    [selected, setSelected] = useState("");
  useEffect(() => watchWallets(() => setWallets(discoverWallets())), []);
  async function walletLogin() {
    const wallet = wallets.find((w) => w.id === selected) || wallets[0];
    if (!wallet)
      throw new Error(
        "Install a browser wallet, or open this page in your wallet’s browser. You can also use a passkey.",
      );
    const address = await connect(wallet.provider);
    const challenge = await api.walletChallenge(address);
    const signature = await signInMessage(
      wallet.provider,
      address,
      challenge.message,
    );
    const response = await api.walletVerify(challenge.challengeId, signature);
    setProvider(wallet.provider);
    signedIn(response.account);
  }
  async function passkey(register = false) {
    if (!browserSupportsWebAuthn())
      throw new Error(
        "This browser does not support passkeys. Try a current browser over HTTPS or localhost.",
      );
    const mode = register ? "register" : "login",
      challenge = await api.request(`/auth/passkey/${mode}/options`, {});
    const response = register
      ? await startRegistration({ optionsJSON: challenge.options })
      : await startAuthentication({ optionsJSON: challenge.options });
    const result = await api.request(`/auth/passkey/${mode}/verify`, {
      challengeId: challenge.challengeId,
      response,
    });
    signedIn(result.account);
  }
  return (
    <div className="welcome">
      <div className="welcome-copy">
        <span className="eyebrow">THE PRIVATE BACK OFFICE</span>
        <h1>
          Good work.
          <br />
          In good company.
        </h1>
        <p>
          A shared home for your team’s AI.
          <br />{" "}
          With a treasury, clear limits and a record
          <br className="desktop-only" /> of every cent.
        </p>
        <div className="welcome-benefits">
          <span>
            <WalletIcon size={17} />
            Your Safe funds the work
          </span>
          <span>
            <ShieldCheck size={17} />
            Your team sets the rules
          </span>
          <span>
            <ReceiptText size={17} />
            Every request has a receipt
          </span>
        </div>
        <div className="welcome-orbit">
          <div />
          <div />
          <img src="/app/brand/mark.svg" alt="Chancery" />
        </div>
      </div>
      <Panel className="signin">
        <div className="signin-icon">
          <LockKeyhole size={24} />
        </div>
        <h2>Welcome to your Office.</h2>
        <p>Sign in to pick up where your team left off.</p>
        <Feedback action={action} />
        {wallets.length > 1 && (
          <Field label="Choose your wallet">
            <select
              value={selected || wallets[0]?.id}
              onChange={(e) => setSelected(e.target.value)}
            >
              {wallets.map((w) => (
                <option value={w.id} key={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Button onClick={() => action.run(walletLogin)} busy={action.busy}>
          <WalletIcon size={18} />
          Continue with wallet
          <ArrowUpRight size={16} />
        </Button>
        <div className="divider">
          <span>or use your passkey</span>
        </div>
        <Button
          kind="secondary"
          onClick={() => action.run(() => passkey())}
          busy={action.busy}
        >
          <Fingerprint size={18} />
          Sign in with a passkey
        </Button>
        <button
          className="text-button"
          disabled={action.busy}
          onClick={() => action.run(() => passkey(true))}
        >
          New here? Create a passkey
        </button>
        <p className="signin-note">
          <LockKeyhole size={13} />
          No email. No personal card.
          <br />
          Signing in never authorizes a payment.
        </p>
        {!config.registry && (
          <div className="setup-note">
            <i />
            Office setup is in progress. You can sign in now.
          </div>
        )}
      </Panel>
    </div>
  );
}
function CreateOffice({
  config,
  created,
  close,
}: {
  config: AppConfig;
  created: (id: string) => Promise<void>;
  close: () => void;
}) {
  const action = useAction(),
    [name, setName] = useState(""),
    [safe, setSafe] = useState(""),
    [cap, setCap] = useState("100");
  return (
    <Modal title="Open an Office" close={close}>
      <form
        onSubmit={submit(() =>
          action.run(async () => {
            const result = await api.request("/offices", {
              name,
              safe,
              monthlyCap: cap,
            });
            await created(result.officeId);
          }),
        )}
      >
        <p className="muted">
          Use an existing Safe v1.4.1 on Robinhood Chain. You’ll review and sign
          the allowance before your Office becomes active.
        </p>
        <Field label="Office name">
          <input
            autoFocus
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your team’s name"
          />
        </Field>
        <Field label="Safe address">
          <input
            required
            pattern="0x[0-9a-fA-F]{40}"
            value={safe}
            onChange={(e) => setSafe(e.target.value.trim())}
            placeholder="0x…"
          />
        </Field>
        <Field
          label="Office budget · USDG per 30 days"
          help="Shared across seats and Clerks. Maximum 5,000 USDG."
        >
          <input
            type="number"
            min="0.01"
            max="5000"
            step="0.01"
            required
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
        </Field>
        <div className="notice">
          <ReceiptText size={17} />
          <span>
            Seats cost 9 USDG per calendar month, prorated daily. AI usage adds
            provider cost plus a 5% platform fee. Both use your Office budget.
          </span>
        </div>
        <Feedback action={action} />
        <Button type="submit" busy={action.busy} disabled={!config.registry}>
          Prepare Safe approval
          <ArrowUpRight size={16} />
        </Button>
      </form>
    </Modal>
  );
}
function JoinOffice({
  close,
  joined,
}: {
  close: () => void;
  joined: () => Promise<void>;
}) {
  const action = useAction(),
    [officeId, setOfficeId] = useState(""),
    [token, setToken] = useState(""),
    [claimed, setClaimed] = useState(false);
  return (
    <Modal title="Join an Office" close={close}>
      {claimed ? (
        <Empty
          title="You’re on the list."
          icon={<Users />}
          action={
            <Button
              kind="secondary"
              onClick={() =>
                action.run(async () => {
                  await joined();
                  close();
                })
              }
            >
              Check for approval
            </Button>
          }
        >
          A Safe owner needs to approve your seat. Once approved, your Office
          will appear in the selector.
        </Empty>
      ) : (
        <form
          onSubmit={submit(() =>
            action.run(async () => {
              await api.office(officeId, "/claim", { token });
              setClaimed(true);
            }),
          )}
        >
          <p className="muted">
            Paste the Office ID and invitation code your team shared with you.
          </p>
          <Field label="Office ID">
            <input
              required
              pattern="0x[0-9a-fA-F]{64}"
              value={officeId}
              onChange={(e) => setOfficeId(e.target.value.trim())}
            />
          </Field>
          <Field label="Invitation code">
            <input
              required
              value={token}
              onChange={(e) => setToken(e.target.value.trim())}
              autoComplete="off"
            />
          </Field>
          <Feedback action={action} />
          <Button busy={action.busy} type="submit">
            Request your seat
            <ArrowUpRight size={16} />
          </Button>
        </form>
      )}
    </Modal>
  );
}
