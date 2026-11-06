import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BadgeCheck,
  Columns2,
  Copy,
  LockKeyhole,
  Play,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  SquarePen,
  Star,
  Trash2,
} from "lucide-react";
import { useOffice } from "../App";
import { api, date, errorText, money, type Model } from "../api";
import { checkGuards } from "../../shared/guards";
import { Button, Empty, Feedback, Field, PageTitle, useAction } from "../ui";
import { Pill, SidePanel, SideItem, SideSection } from "../shell";
import { dayGroup, groupBy, shortId, time } from "../data";
import "./Compare.css";
// Side by Side (RELEASED_UPDATES=side_by_side). Rendered inside the update gate in Updates.tsx.

type Problem = { code: string; message: string };
type Priced = {
  models: {
    model: string;
    quote: { id: string; maximumUsd: string; expiresAt: string } | null;
    problem: Problem | null;
  }[];
  totalMaximumUsd: string;
  expiresAt: string | null;
  ready: boolean;
  problem: Problem | null;
};
type Column = {
  position: number;
  model: string;
  requestId: string;
  maximumUsd: string;
  state: string;
  content: string | null;
  chargedUsd: string | null;
  receiptId: string | null;
  receipt: any;
  durationMs: number | null;
  tokens: { input: number | null; output: number | null } | null;
  error: Problem | null;
};
type Comparison = {
  id: string;
  prompt: string;
  maxTokens: number;
  totalMaximumUsd: string;
  favourite: string | null;
  createdAt: string;
  columns: Column[];
};
type Saved = {
  id: string;
  title: string;
  models: string[];
  favourite: string | null;
  createdAt: string;
};

const price = (m: Model) =>
  Number(m.inputUsdPerMillion) + Number(m.outputUsdPerMillion);
/* Start with the cheapest and the priciest model, so the difference is easy to see. */
function defaults(models: Model[]) {
  const sorted = [...models].sort((a, b) => price(a) - price(b));
  return sorted.length < 2
    ? sorted.map((m) => m.id)
    : [sorted[0].id, sorted[sorted.length - 1].id];
}
const seconds = (ms: number | null) =>
  ms === null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
const budgetHelp: Record<string, string> = {
  actor_cap:
    "Your seat's monthly spending cap doesn't have room for all of them.",
  office_cap: "The Office's monthly budget doesn't have room for all of them.",
  allowance_cap: "The Safe allowance doesn't have room for all of them.",
  safe_balance: "The Safe doesn't hold enough USDG for all of them.",
};
function stateLabel(c: Column): {
  label: string;
  tone: "green" | "amber" | "red" | "";
} {
  if (c.state === "complete") return { label: "Done", tone: "green" };
  if (c.state === "uncertain")
    return {
      label: c.content ? "Price pending" : "Unconfirmed",
      tone: "amber",
    };
  if (c.state === "refused") return { label: "Declined", tone: "red" };
  if (c.state === "blocked") return { label: "Not sent", tone: "red" };
  if (c.state === "waiting") return { label: "Not started", tone: "" };
  return { label: "Running", tone: "" };
}
const answered = (c: Column) => !!c.content && c.chargedUsd !== null;

export function Compare() {
  const { office, models, navigate } = useOffice(),
    action = useAction(),
    [saved, setSaved] = useState<Saved[]>([]),
    [prompt, setPrompt] = useState(""),
    [picked, setPicked] = useState<string[]>([]),
    [maxTokens, setMaxTokens] = useState(1024),
    [priced, setPriced] = useState<Priced | null>(null),
    [comparison, setComparison] = useState<Comparison | null>(null),
    [running, setRunning] = useState(0),
    [verified, setVerified] = useState<Record<string, boolean>>({}),
    [now, setNow] = useState(Date.now());
  const available = useMemo(
    () =>
      models.filter(
        (m) =>
          (!office.policy.allowedModels.length ||
            office.policy.allowedModels.includes(m.id)) &&
          m.lanes.includes("standard"),
      ),
    [models, office.policy.allowedModels.join(",")],
  );
  const name = (id: string) => models.find((m) => m.id === id)?.name || id;
  const limit = Math.min(
    8192,
    ...available.filter((m) => picked.includes(m.id)).map((m) => m.maxTokens),
  );
  const guard = checkGuards(prompt),
    allowed =
      office.status === "active" &&
      office.seatStatus === "active" &&
      office.moduleEnabled &&
      office.role !== "guest" &&
      office.policy.allowedLanes.includes("standard");
  useEffect(() => {
    setPicked((current) => {
      const kept = current.filter((id) => available.some((m) => m.id === id));
      return kept.length ? kept : defaults(available);
    });
  }, [available]);
  useEffect(() => setMaxTokens((n) => Math.min(n, limit)), [limit]);
  // Any change to the question or the models makes the prices stale.
  useEffect(() => setPriced(null), [prompt, picked.join(","), maxTokens]);
  useEffect(() => {
    if (!priced) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [priced]);
  async function load() {
    setSaved(await api.office(office.id, "/comparisons"));
  }
  useEffect(() => {
    if (office.role !== "guest") void action.run(load);
  }, [office.id]);

  function toggle(id: string) {
    setPicked((current) =>
      current.includes(id)
        ? current.filter((x) => x !== id)
        : current.length >= 3
          ? current
          : [...current, id],
    );
  }
  async function getPrices() {
    if (guard) throw new Error(guard.message);
    setPriced(
      await api.office(office.id, "/comparisons/quotes", {
        prompt: prompt.trim(),
        models: picked,
        maxTokens,
      }),
    );
    setNow(Date.now());
  }
  function replace(column: Column) {
    setComparison((current) =>
      current && current.columns.some((c) => c.requestId === column.requestId)
        ? {
            ...current,
            columns: current.columns.map((c) =>
              c.position === column.position ? column : c,
            ),
          }
        : current,
    );
  }
  /* Columns run in parallel and fill in as each answer arrives. One failure leaves the others alone. */
  async function runColumn(view: Comparison, c: Column) {
    setRunning((n) => n + 1);
    replace({ ...c, state: "running" });
    try {
      replace(
        await api.office(
          office.id,
          `/comparisons/${view.id}/columns/${c.position}/run`,
          {},
        ),
      );
    } catch (error) {
      replace({
        ...c,
        state: "blocked",
        error: { code: "request_failed", message: errorText(error) },
      });
    } finally {
      setRunning((n) => n - 1);
    }
  }
  async function start() {
    if (!priced) return;
    const view: Comparison = await api.office(office.id, "/comparisons", {
      prompt: prompt.trim(),
      models: picked,
      maxTokens,
      quoteIds: priced.models.map((m) => m.quote!.id),
      approvedMaximumUsd: priced.totalMaximumUsd,
    });
    setPriced(null);
    setComparison(view);
    setVerified({});
    void load().catch(() => {});
    void Promise.all(view.columns.map((c) => runColumn(view, c))).then(() =>
      load().catch(() => {}),
    );
  }
  async function open(id: string) {
    setComparison(await api.office(office.id, `/comparisons/${id}`));
    setVerified({});
    setPriced(null);
  }
  async function choose(requestId: string) {
    if (!comparison) return;
    const next = comparison.favourite === requestId ? null : requestId;
    await api.office(office.id, `/comparisons/${comparison.id}/favourite`, {
      requestId: next,
    });
    setComparison({ ...comparison, favourite: next });
    await load();
  }
  async function remove(item: Saved) {
    await api.request(
      `/offices/${office.id}/comparisons/${item.id}`,
      undefined,
      "DELETE",
    );
    if (comparison?.id === item.id) setComparison(null);
    await load();
    action.setNotice(
      "Comparison deleted. Billing receipts stay in the Ledger.",
    );
  }
  async function verify(c: Column) {
    const result = await api.request("/verify", { envelope: c.receipt });
    setVerified((v) => ({ ...v, [c.requestId]: !!result.valid }));
  }
  function again(text: string) {
    setComparison(null);
    setPrompt(text);
  }

  if (office.role === "guest")
    return (
      <>
        <SidePanel title="Side by Side" />
        <Empty
          icon={<LockKeyhole />}
          title="Side by Side is for Office members."
        >
          Your guest access covers your invited Rooms.
        </Empty>
      </>
    );

  const secondsLeft = priced?.expiresAt
    ? Math.max(0, Math.ceil((Date.parse(priced.expiresAt) - now) / 1000))
    : 0;
  const groups = groupBy(saved, (s) => dayGroup(s.createdAt));
  const done = comparison?.columns.filter(answered) || [];
  const cheapest = [...done].sort(
      (a, b) => Number(a.chargedUsd) - Number(b.chargedUsd),
    )[0],
    fastest = [...done]
      .filter((c) => c.durationMs !== null)
      .sort((a, b) => a.durationMs! - b.durationMs!)[0],
    spent = (comparison?.columns || []).reduce(
      (n, c) => n + (Number(c.chargedUsd) || 0),
      0,
    );

  return (
    <div className="compare-page">
      <SidePanel title="Side by Side">
        <button
          className="side-new"
          disabled={running > 0 || action.busy}
          onClick={() => {
            setComparison(null);
            setPriced(null);
          }}
        >
          <SquarePen size={15} />
          New comparison
        </button>
        {saved.length ? (
          [...groups.entries()].map(([label, list]) => (
            <SideSection label={label} key={label}>
              {list.map((s) => (
                <div
                  className={`side-row ${comparison?.id === s.id ? "active" : ""}`}
                  key={s.id}
                >
                  <SideItem
                    active={comparison?.id === s.id}
                    title={s.title}
                    meta={`${s.models.length} models · ${time(s.createdAt)}`}
                    disabled={running > 0}
                    onClick={() => action.run(() => open(s.id))}
                  />
                  <button
                    className="icon-button side-row-action"
                    aria-label={`Delete ${s.title}`}
                    title="Delete comparison"
                    disabled={action.busy || running > 0}
                    onClick={() => action.run(() => remove(s))}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </SideSection>
          ))
        ) : (
          <p className="side-note">Your comparisons are saved here.</p>
        )}
      </SidePanel>
      <PageTitle eyebrow="Side by Side" title="Compare models">
        Ask a few models the same question, then see which answer is worth
        paying for.
      </PageTitle>
      <Feedback action={action} />

      {!comparison ? (
        <section className="panel compare-composer">
          <Field label="Your question">
            <textarea
              rows={4}
              maxLength={20000}
              value={prompt}
              disabled={!allowed || action.busy}
              placeholder={
                allowed
                  ? "For example: Explain the difference between a budget and a forecast."
                  : "Approve your Office and seat to compare models."
              }
              onChange={(e) => setPrompt(e.target.value)}
            />
          </Field>
          {guard && (
            <div className="guard-message" role="alert">
              <ShieldCheck size={14} />
              {guard.message}
            </div>
          )}
          <div className="compare-models-head">
            <strong>Models</strong>
            <span className="muted">Pick 2 or 3 · {picked.length} picked</span>
          </div>
          {available.length < 2 ? (
            <p className="muted">
              Side by Side needs at least two models allowed by your Office
              policy. A Principal can allow more in Settings.
            </p>
          ) : (
            <div className="compare-models" role="group" aria-label="Models">
              {available.map((m) => {
                const on = picked.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`compare-model ${on ? "on" : ""}`}
                    aria-pressed={on}
                    disabled={(!on && picked.length >= 3) || action.busy}
                    onClick={() => toggle(m.id)}
                  >
                    <strong>{m.name}</strong>
                    <small>
                      ${Number(m.inputUsdPerMillion)} in · $
                      {Number(m.outputUsdPerMillion)} out per 1M tokens
                    </small>
                  </button>
                );
              })}
            </div>
          )}
          <div className="compare-composer-foot">
            <details className="options">
              <summary>Options</summary>
              <div className="popover options-pop">
                <Field
                  label="Longest answer (tokens)"
                  help="A lower limit lowers the maximum price."
                >
                  <input
                    type="number"
                    min="1"
                    max={limit}
                    value={maxTokens}
                    onChange={(e) =>
                      setMaxTokens(
                        Math.max(
                          1,
                          Math.min(limit, Number(e.target.value) || 1),
                        ),
                      )
                    }
                  />
                </Field>
              </div>
            </details>
            <span className="muted compare-hint">
              Each model is billed as its own request, with its own receipt.
            </span>
            <Button
              busy={action.busy && !priced}
              disabled={
                !allowed ||
                !prompt.trim() ||
                !!guard ||
                picked.length < 2 ||
                picked.length > 3 ||
                !!priced
              }
              onClick={() => action.run(getPrices)}
            >
              See prices
            </Button>
          </div>
          {priced && (
            <div
              className="compare-review"
              role="dialog"
              aria-label="Review prices"
            >
              <ul>
                {priced.models.map((m) => (
                  <li key={m.model}>
                    <span>{name(m.model)}</span>
                    {m.quote ? (
                      <strong>up to {money(m.quote.maximumUsd, 6)} USDG</strong>
                    ) : (
                      <span className="error-text">{m.problem?.message}</span>
                    )}
                  </li>
                ))}
              </ul>
              {priced.problem && (
                <div className="notice warning" role="alert">
                  <span>
                    {budgetHelp[priced.problem.code]
                      ? `Together these answers could cost up to ${money(priced.totalMaximumUsd, 6)} USDG. ${budgetHelp[priced.problem.code]} Pick fewer or cheaper models, or a shorter answer.`
                      : priced.problem.message}
                  </span>
                </div>
              )}
              <div className="compare-review-foot">
                <span className="muted">
                  You pay only what each answer actually costs, never more than
                  this.{" "}
                  {secondsLeft > 0
                    ? `Prices valid ${secondsLeft}s.`
                    : "Prices expired."}
                </span>
                <Button kind="ghost" onClick={() => setPriced(null)}>
                  Cancel
                </Button>
                <Button
                  busy={action.busy}
                  disabled={!priced.ready || secondsLeft <= 0}
                  onClick={() => action.run(start)}
                >
                  <Columns2 size={15} />
                  Compare for up to {money(priced.totalMaximumUsd, 6)} USDG
                </Button>
              </div>
            </div>
          )}
        </section>
      ) : (
        <>
          <section className="panel compare-question">
            <div>
              <span className="eyebrow">Question</span>
              <p>{comparison.prompt}</p>
              <small className="muted">
                {date(comparison.createdAt)} · approved up to{" "}
                {money(comparison.totalMaximumUsd, 6)} USDG
                {spent > 0 && ` · spent ${money(spent, 6)} USDG`}
              </small>
            </div>
            <div className="compare-question-actions">
              {comparison.columns.some((c) =>
                ["running", "inflight"].includes(c.state),
              ) &&
                !running && (
                  <Button
                    kind="secondary"
                    busy={action.busy}
                    onClick={() => action.run(() => open(comparison.id))}
                  >
                    <RefreshCw size={14} />
                    Check again
                  </Button>
                )}
              <Button
                kind="secondary"
                disabled={running > 0}
                onClick={() => again(comparison.prompt)}
              >
                Ask again
              </Button>
            </div>
          </section>
          {done.length >= 2 && (
            <p className="compare-summary" role="status">
              <span>
                Cheapest: <strong>{name(cheapest.model)}</strong> (
                {money(cheapest.chargedUsd, 6)} USDG)
              </span>
              {fastest && (
                <span>
                  Fastest: <strong>{name(fastest.model)}</strong> (
                  {seconds(fastest.durationMs)})
                </span>
              )}
            </p>
          )}
          <div
            className="compare-columns"
            style={{ ["--cols" as string]: comparison.columns.length }}
          >
            {comparison.columns.map((c) => {
              const st = stateLabel(c),
                best = comparison.favourite === c.requestId;
              return (
                <article
                  key={c.requestId}
                  className={`compare-column ${best ? "best" : ""}`}
                  aria-busy={["running", "inflight"].includes(c.state)}
                >
                  <header>
                    <h2>{name(c.model)}</h2>
                    {best && (
                      <span className="compare-best-tag">
                        <Star size={12} /> Best answer
                      </span>
                    )}
                    <Pill tone={st.tone}>{st.label}</Pill>
                  </header>
                  <div className="compare-answer">
                    {c.content ? (
                      <div className="markdown">
                        <Markdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            img: () => null,
                            a: ({ children, href }) => (
                              <a href={href} target="_blank" rel="noreferrer">
                                {children}
                              </a>
                            ),
                          }}
                        >
                          {c.content}
                        </Markdown>
                      </div>
                    ) : ["running", "inflight"].includes(c.state) ? (
                      <div className="compare-waiting">
                        <div className="thinking">
                          <span />
                          <span />
                          <span />
                        </div>
                        Waiting for the answer…
                      </div>
                    ) : c.state === "waiting" ? (
                      <div className="compare-waiting">
                        This model hasn’t run yet.
                        <Button
                          kind="secondary"
                          disabled={running > 0}
                          onClick={() => void runColumn(comparison, c)}
                        >
                          <Play size={14} />
                          Run it now
                        </Button>
                      </div>
                    ) : null}
                    {c.error && (
                      <div className="notice error">
                        <span>{c.error.message}</span>
                      </div>
                    )}
                  </div>
                  <dl className="compare-stats">
                    <div>
                      <dt>Cost</dt>
                      <dd>
                        {c.chargedUsd !== null
                          ? `${money(c.chargedUsd, 6)} USDG`
                          : "—"}
                        <small>up to {money(c.maximumUsd, 6)}</small>
                      </dd>
                    </div>
                    <div>
                      <dt>Time</dt>
                      <dd>{seconds(c.durationMs)}</dd>
                    </div>
                    <div>
                      <dt>Tokens</dt>
                      <dd>
                        {c.tokens
                          ? `${c.tokens.input ?? "—"} in · ${c.tokens.output ?? "—"} out`
                          : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt>Receipt</dt>
                      <dd>
                        {c.receiptId ? (
                          <code title={c.receiptId}>
                            {shortId(c.receiptId)}
                          </code>
                        ) : (
                          "—"
                        )}
                        {verified[c.requestId] !== undefined && (
                          <small
                            className={verified[c.requestId] ? "ok" : "bad"}
                          >
                            {verified[c.requestId]
                              ? "Signature valid"
                              : "Signature invalid"}
                          </small>
                        )}
                      </dd>
                    </div>
                  </dl>
                  <footer>
                    {c.content && (
                      <>
                        <button
                          className={best ? "on" : ""}
                          aria-pressed={best}
                          disabled={action.busy}
                          onClick={() => action.run(() => choose(c.requestId))}
                        >
                          <Star size={14} />
                          Best answer
                        </button>
                        <button
                          onClick={() =>
                            action.run(async () => {
                              await navigator.clipboard.writeText(c.content!);
                              action.setNotice("Answer copied.");
                            })
                          }
                        >
                          <Copy size={14} />
                          Copy
                        </button>
                      </>
                    )}
                    {c.receipt && (
                      <>
                        <button
                          disabled={action.busy}
                          onClick={() => action.run(() => verify(c))}
                        >
                          <BadgeCheck size={14} />
                          Verify
                        </button>
                        <button onClick={() => navigate("ledger")}>
                          <ReceiptText size={14} />
                          Ledger
                        </button>
                      </>
                    )}
                  </footer>
                </article>
              );
            })}
          </div>
          <p className="compare-note muted">
            Each column is a separate request with its own signed receipt in the
            Ledger. Prices depend on the model and on how long the answer is.
          </p>
        </>
      )}
    </div>
  );
}
