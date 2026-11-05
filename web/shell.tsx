import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Search } from "lucide-react";
import { money } from "./api";

/* ------------------------------------------------------------------
   Secondary panel slot. The shell renders an empty column; each page
   fills it with <SidePanel> so the list it needs sits beside its content.
   ------------------------------------------------------------------ */
const PanelHost = createContext<HTMLElement | null>(null);
export const PanelHostProvider = PanelHost.Provider;

export function SidePanel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const host = useContext(PanelHost);
  if (!host) return null;
  return createPortal(
    <div className="side-inner">
      <div className="side-head">
        <h1>{title}</h1>
        {action}
      </div>
      <div className="side-scroll">{children}</div>
    </div>,
    host,
  );
}

export function SideSection({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <section className="side-section">
      {label && <h2 className="side-label">{label}</h2>}
      {children}
    </section>
  );
}

export function SideItem({
  active,
  onClick,
  title,
  meta,
  trailing,
  leading,
  disabled,
}: {
  active?: boolean;
  onClick?: () => void;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  leading?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      className={`side-item ${active ? "active" : ""}`}
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      disabled={disabled}
    >
      {leading && <span className="side-item-lead">{leading}</span>}
      <span className="side-item-body">
        <span className="side-item-title">{title}</span>
        {meta && <span className="side-item-meta">{meta}</span>}
      </span>
      {trailing && <span className="side-item-trail">{trailing}</span>}
    </button>
  );
}

/* Allowance footer shown at the foot of every secondary panel. */
export function AllowanceFooter({
  name,
  capUsd,
  spentUsd,
}: {
  name: string;
  capUsd: string;
  spentUsd: string;
}) {
  const cap = Number(capUsd) || 0,
    spent = Number(spentUsd) || 0,
    available = Math.max(0, cap - spent),
    percent = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  return (
    <div className="allowance-foot">
      <strong>{name}</strong>
      <span>{money(available)} USDG available</span>
      <div
        className={`meter ${meterTone(percent)}`}
        aria-label={`${percent.toFixed(0)}% of allowance used`}
      >
        <i style={{ width: `${percent}%` }} />
      </div>
      <small>{percent.toFixed(0)}% used</small>
    </div>
  );
}

/* Small UI atoms used across pages ------------------------------- */

/* A stable hue per person. Wallets are keyed on their first four hex
   digits so the short form (0x19e7…ff2a) and the full address match. */
export function avatarHue(value: string) {
  const v = value.toLowerCase().replace(/^[a-z]+_/, "");
  const seed = /^0x[0-9a-f]{4}/.test(v) ? v.slice(2, 6) : v;
  let h = 7;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}
/* Hues that sit well beside periwinkle and mauve; skips muddy olives. */
const HUES = [250, 278, 302, 328, 352, 18, 40, 168, 192, 218];
export const avatarStyle = (value: string) =>
  ({ "--h": avatarHue(value) }) as CSSProperties;
export const initials = (value: string) =>
  value
    .replace(/^[a-z]+_/i, "")
    .replace(/^0x/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 2)
    .toUpperCase();

export function Monogram({ value, tone = "" }: { value: string; tone?: string }) {
  return (
    <span className={`monogram tinted ${tone}`} style={avatarStyle(value)}>
      {initials(value) || "··"}
    </span>
  );
}

/* Allowance meters warn before they run out. */
export const meterTone = (percent: number) =>
  percent >= 95 ? "red" : percent >= 80 ? "amber" : "";

/* Figures count up from zero when they first appear (and glide when
   they change), easing out so the last digits settle gently. */
export function useCountUp(target: number, enabled = true, ms = 900) {
  const [value, setValue] = useState(enabled ? 0 : target);
  const shown = useRef(enabled ? 0 : target);
  useEffect(() => {
    if (
      !enabled ||
      typeof requestAnimationFrame === "undefined" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      shown.current = target;
      setValue(target);
      return;
    }
    const from = shown.current,
      start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / ms),
        eased = 1 - Math.pow(1 - k, 4);
      shown.current = from + (target - from) * eased;
      setValue(k === 1 ? target : shown.current);
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, enabled, ms]);
  return value;
}
export function Count({ value }: { value: number }) {
  return <>{Math.round(useCountUp(value)).toLocaleString()}</>;
}

export function Stat({
  label,
  value,
  unit,
  hint,
  loading,
  meter,
  tone,
  feature,
  onClick,
  action,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  loading?: boolean;
  /** 0–100: draws a thin usage meter under the figure. */
  meter?: number;
  /** Small status dot beside the label. */
  tone?: "green" | "amber" | "red";
  /** The headline figure on a page: drawn on a deep ink card. */
  feature?: boolean;
  /** Makes the whole card a link to where the figure comes from. */
  onClick?: () => void;
  /** Screen-reader name for the destination, e.g. "Open the Ledger". */
  action?: string;
}) {
  const Tag = onClick ? "button" : "div";
  const meterValue = useCountUp(meter ?? 0, meter !== undefined && !loading, 1100);
  return (
    <Tag
      className={`stat ${feature ? "feature" : ""} ${onClick ? "interactive" : ""}`}
      onClick={onClick}
      aria-label={onClick && action ? `${label}: ${action}` : undefined}
    >
      {onClick && <ArrowUpRight size={15} className="stat-go" aria-hidden />}
      <span>
        {tone && <i className={`stat-dot ${tone}`} aria-hidden />}
        {label}
      </span>
      {loading ? (
        <strong>
          <span className="skeleton" style={{ width: "6ch" }} />
        </strong>
      ) : (
        <strong>
          {value}
          {unit && <small> {unit}</small>}
        </strong>
      )}
      {meter !== undefined && !loading && (
        <span className={`stat-meter ${meterTone(meter)}`}>
          <i style={{ width: `${Math.min(100, Math.max(0, meterValue))}%` }} />
        </span>
      )}
      {loading ? (
        <em>
          <span className="skeleton" style={{ width: "14ch" }} />
        </em>
      ) : (
        hint && <em>{hint}</em>
      )}
    </Tag>
  );
}

export function Pill({
  tone = "",
  children,
}: {
  tone?: "green" | "amber" | "red" | "ink" | "";
  children: ReactNode;
}) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Progress({
  value,
  max,
  tone = "",
}: {
  value: number;
  max: number;
  tone?: string;
}) {
  const percent = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <span className={`progress ${tone || meterTone(percent)}`}>
      <i style={{ width: `${percent}%` }} />
    </span>
  );
}

export function Dots({ have, need }: { have: number; need: number }) {
  return (
    <span className="dots" aria-label={`${have} of ${need} signatures`}>
      {Array.from({ length: Math.max(need, 1) }, (_, i) => (
        <i key={i} className={i < have ? "on" : ""} />
      ))}
    </span>
  );
}

/* Amounts dim only what carries no information: ".00" on whole numbers
   and trailing zeros on high-precision values. 0.01 stays fully legible. */
export function Amount({
  value,
  places = 2,
  animate = false,
}: {
  value: unknown;
  places?: number;
  /** Count up to the value instead of showing it at once. */
  animate?: boolean;
}) {
  const target = Number(value) || 0;
  /* Sub-cent values switch to six decimals, so they don't count. */
  const counts = animate && (target === 0 || target >= 0.01);
  const counted = useCountUp(target, counts);
  const text = counts
    ? new Intl.NumberFormat("en-US", {
        minimumFractionDigits: places,
        maximumFractionDigits: places,
      }).format(counted)
    : money(value, places);
  const dot = text.lastIndexOf(".");
  if (dot < 0) return <span className="amount">{text}</span>;
  const decimals = text.slice(dot + 1);
  const cut = /^0+$/.test(decimals)
    ? dot
    : places > 2
      ? dot + 1 + decimals.replace(/0+$/, "").length
      : text.length;
  return (
    <span className="amount">
      {text.slice(0, cut)}
      {cut < text.length && <small>{text.slice(cut)}</small>}
    </span>
  );
}

/* Spend chart: cumulative line from daily points. Pure SVG, no library. */
export function SpendChart({
  points,
  days,
  label,
  month,
}: {
  points: { day: number; value: number }[];
  days: number;
  label: string;
  /** YYYY-MM, used to name the hovered day. */
  month?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const gradient = `spend-${useId().replace(/:/g, "")}`;
  /* Draw at the real pixel width so labels stay 11px on any screen. */
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760);
  useEffect(() => {
    if (!box.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(260, Math.round(entry.contentRect.width))),
    );
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  const narrow = width < 520;
  const height = narrow ? 180 : Math.round(Math.min(260, Math.max(200, width * 0.25))),
    left = 56,
    right = 12,
    top = 12,
    bottom = 28;
  const max = Math.max(1e-6, ...points.map((p) => p.value));
  const step = niceStep(max / 4);
  const ceiling = Math.ceil(max / step - 1e-9) * step || 1;
  const places = decimalsFor(step);
  const x = (d: number) => left + ((d - 1) / Math.max(1, days - 1)) * (width - left - right);
  const y = (v: number) => top + (1 - v / ceiling) * (height - top - bottom);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.day)},${y(p.value)}`).join("");
  const area = points.length
    ? `${line}L${x(points[points.length - 1].day)},${y(0)}L${x(points[0].day)},${y(0)}Z`
    : "";
  const ticks = Array.from({ length: Math.round(ceiling / step) + 1 }, (_, i) => i * step);
  const labels = narrow
    ? [1, Math.ceil(days / 2), days]
    : [1, Math.ceil(days / 4), Math.ceil(days / 2), Math.ceil((3 * days) / 4), days];
  const latest = points[points.length - 1];
  const hovered = hover !== null ? points.find((p) => p.day === hover) : latest;
  const dayName = (day: number) =>
    month
      ? new Date(`${month}-${String(day).padStart(2, "0")}T12:00:00Z`).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        })
      : `Day ${day}`;
  return (
    <div className="chart" ref={box}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * width;
          const day = Math.round(((px - left) / (width - left - right)) * (days - 1) + 1);
          const near = points.reduce<number | null>(
            (best, p) => (best === null || Math.abs(p.day - day) < Math.abs(best - day) ? p.day : best),
            null,
          );
          if (near !== null) setHover(near);
        }}
      >
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" className="area-top" />
            <stop offset="100%" className="area-bottom" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} className={t === 0 ? "grid base" : "grid"} />
            <text x={left - 10} y={y(t) + 4} textAnchor="end" className="tick">
              {formatTick(t, places)}
            </text>
          </g>
        ))}
        {labels.map((d) => (
          <text key={d} x={x(d)} y={height - 6} textAnchor="middle" className="tick">
            {d}
          </text>
        ))}
        {points.length > 0 && (
          <>
            <path d={area} className="area" fill={`url(#${gradient})`} />
            <path d={line} className="line" pathLength={1} />
          </>
        )}
        {latest && hover === null && (
          <circle cx={x(latest.day)} cy={y(latest.value)} r={4.5} className="halo" />
        )}
        {hovered && (
          <g>
            <line x1={x(hovered.day)} x2={x(hovered.day)} y1={y(hovered.value)} y2={y(0)} className="guide" />
            <circle cx={x(hovered.day)} cy={y(hovered.value)} r={4.5} className="dot" />
          </g>
        )}
      </svg>
      {hovered && (
        <div
          className={`chart-tip ${narrow && y(hovered.value) < 64 ? "below" : ""}`}
          style={{
            left: `${Math.min(width - 70, Math.max(70, x(hovered.day)))}px`,
            top: `${(y(hovered.value) / height) * 100}%`,
          }}
        >
          <small>{dayName(hovered.day)}{hovered === latest && hover === null ? " · latest" : ""}</small>
          <strong>{money(hovered.value, hovered.value && hovered.value < 0.01 ? 4 : 2)} USDG</strong>
        </div>
      )}
    </div>
  );
}
function niceStep(raw: number) {
  const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const n = raw / power;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * power;
}
/* Every axis label gets the same number of decimals, so they line up. */
function decimalsFor(step: number) {
  for (let d = 0; d < 7; d++) if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-6) return d;
  return 6;
}
function formatTick(v: number, places: number) {
  if (v >= 1000) return `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k`;
  if (v === 0) return "0";
  return v.toFixed(places);
}

/* ⌘K command menu: jump to pages and actions. No server search. */
export type Command = { id: string; label: string; hint?: string; run: () => void };
export function CommandMenu({ commands }: { commands: Command[] }) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null),
    wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
    };
    const click = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", click);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mousedown", click);
    };
  }, []);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
  }, [query, commands]);
  const choose = (c: Command) => {
    c.run();
    setOpen(false);
    setQuery("");
    input.current?.blur();
  };
  const mac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
  return (
    <div className="command" ref={wrap}>
      <Search size={16} />
      <input
        ref={input}
        value={query}
        placeholder="Jump to a page or action…"
        aria-label="Jump to a page or action"
        aria-expanded={open}
        role="combobox"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => Math.min(i + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && matches[index]) {
            e.preventDefault();
            choose(matches[index]);
          } else if (e.key === "Escape") {
            setOpen(false);
            input.current?.blur();
          }
        }}
      />
      <kbd>{mac ? "⌘K" : "Ctrl K"}</kbd>
      {open && matches.length > 0 && (
        <div className="command-menu" role="listbox">
          {matches.map((c, i) => (
            <button
              key={c.id}
              role="option"
              aria-selected={i === index}
              className={i === index ? "active" : ""}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(c);
              }}
            >
              <span>{c.label}</span>
              {c.hint && <small>{c.hint}</small>}
            </button>
          ))}
          <div className="command-foot" aria-hidden>
            <span><kbd>↑</kbd><kbd>↓</kbd> Move</span>
            <span><kbd>↵</kbd> Open</span>
            <span><kbd>esc</kbd> Close</span>
          </div>
        </div>
      )}
    </div>
  );
}
