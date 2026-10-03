import { ChanceryClient, ChanceryError } from "../packages/client/api";
export { ChanceryError };
export const api = new ChanceryClient();
export type Account = { id: string; wallet: string | null; credential: string };
export type AppConfig = {
  chainId: number;
  registry: string | null;
  token: string | null;
  aiProvider: string;
  updates: { id: string; name: string; enabled: boolean }[];
  addresses: Record<string, string>;
  privacy: Record<string, string>;
};
export type Office = {
  id: string;
  name: string;
  safe: string;
  status: string;
  role: string;
  seatStatus: string;
  seatId: string;
  capUsd: string;
  spentUsd: string;
  owners: string[];
  threshold: number;
  moduleEnabled: boolean;
  periodStart: string | null;
  delegate: string;
  policy: {
    mandatoryGuards: boolean;
    allowedModels: string[];
    allowedLanes: string[];
    maxRequestUsd: string;
  };
};
export type Model = {
  id: string;
  name: string;
  maxTokens: number;
  contextLength: number;
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  lanes: string[];
};
export type Message = {
  role: "user" | "assistant";
  content: string;
  id?: string;
  model?: string;
  createdAt?: string;
};
export type Conversation = {
  id: string;
  title: string;
  ephemeral: boolean;
  createdAt: string;
};
export type Quote = {
  id: string;
  maximumUsd: string;
  expiresAt: string;
  envelope: any;
};
export type Receipt = {
  id: string;
  created_at: string;
  envelope: { payload: Record<string, any> };
  settlement_id: string | null;
  anchor_id: string | null;
};
export function errorText(error: unknown) {
  if (error instanceof ChanceryError) return error.message;
  if (
    (error as any)?.code === 4001 ||
    (error as any)?.name === "NotAllowedError"
  )
    return "The request was cancelled. You can try again when ready.";
  if (error instanceof TypeError && /fetch|network/i.test(error.message))
    return "Unable to reach Chancery. Check your connection and try again.";
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
export const short = (value: string | null | undefined) =>
  value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—";
export function money(value: unknown, places = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value)))
    return "—";
  const number = Number(value);
  if (number > 0 && number < 0.01 && places === 2)
    return number.toFixed(6).replace(/0+$/, "");
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  }).format(number);
}
export function date(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
}
export function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function exportLedger(
  officeId: string,
  month: string,
  format: "csv" | "json",
) {
  const response = await fetch(
    `/api/offices/${encodeURIComponent(officeId)}/ledger/export?month=${encodeURIComponent(month)}&format=${format}`,
    { credentials: "include" },
  );
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error?.message || "Export failed.");
  }
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `chancery-${month}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
