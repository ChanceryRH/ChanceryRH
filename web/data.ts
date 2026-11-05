import type { Receipt } from "./api";

/* Helpers that read signed receipt envelopes. Values come straight from the
   server-signed payload; nothing here invents data. */
export const payload = (r: Receipt) => r.envelope.payload || {};
export const charged = (r: Receipt) => Number(payload(r).chargedUsd) || 0;
export const isSeatFee = (r: Receipt) => payload(r).type === "seat_fee";
export const modelLabel = (r: Receipt, names?: Map<string, string>) =>
  isSeatFee(r)
    ? "Seat fee"
    : names?.get(payload(r).model) || payload(r).model || "—";
export function tokens(r: Receipt) {
  const u = payload(r).usage;
  if (!u) return null;
  const input = Number(u.prompt_tokens ?? u.input_tokens),
    output = Number(u.completion_tokens ?? u.output_tokens);
  return Number.isFinite(input) || Number.isFinite(output)
    ? { input: Number.isFinite(input) ? input : 0, output: Number.isFinite(output) ? output : 0 }
    : null;
}
export type Tone = "green" | "amber" | "red" | "";
export function receiptState(r: Receipt): { label: string; tone: Tone } {
  const p = payload(r);
  if (p.status === "failed") return { label: "Failed", tone: "red" };
  if (p.status === "pending") return { label: "Provisional", tone: "amber" };
  if (r.settlement_id) return { label: "Settled", tone: "green" };
  return { label: "Awaiting settlement", tone: "amber" };
}
export const sum = (rows: Receipt[]) => rows.reduce((t, r) => t + charged(r), 0);

/* Cumulative spend by day of the month (UTC), up to today. */
export function cumulativeByDay(rows: Receipt[], month: string) {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const now = new Date();
  const isCurrent = now.getUTCFullYear() === y && now.getUTCMonth() + 1 === m;
  const last = isCurrent ? now.getUTCDate() : days;
  const daily = new Array(days + 1).fill(0);
  for (const r of rows) {
    const d = new Date(r.created_at);
    if (d.getUTCFullYear() === y && d.getUTCMonth() + 1 === m)
      daily[d.getUTCDate()] += charged(r);
  }
  const points: { day: number; value: number }[] = [];
  let running = 0;
  for (let day = 1; day <= last; day++) {
    running += daily[day];
    points.push({ day, value: running });
  }
  return { points, days };
}

export function groupBy<T>(rows: T[], key: (row: T) => string) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    map.set(k, [...(map.get(k) || []), row]);
  }
  return map;
}

export const thisMonth = () => new Date().toISOString().slice(0, 7);
export function monthLabel(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
export function recentMonths(count: number) {
  const now = new Date();
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return d.toISOString().slice(0, 7);
  });
}
export function dayGroup(value: string) {
  const d = new Date(value),
    today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  return diff <= 0 ? "Today" : diff === 1 ? "Yesterday" : diff < 7 ? "This week" : "Earlier";
}
export function time(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "—";
}
export function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export const shortId = (id: string) => {
  const core = id.replace(/^[a-z]+_/, "");
  return core.length > 12 ? `${core.slice(0, 6)}…${core.slice(-4)}` : core;
};

/* "awaiting_signatures" → "Awaiting signatures" for status pills. */
export const sentence = (value: string | null | undefined) => {
  const v = String(value || "").replace(/_/g, " ");
  return v.charAt(0).toUpperCase() + v.slice(1);
};
