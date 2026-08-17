export {
  picoToUsdString,
  picoToUsdg,
  usdgToPico,
  mulBps,
  allocate,
  PICO_PER_USD,
  PICO_PER_USDG_UNIT,
} from "./decimal.ts";
import { usdToPico } from "./decimal.ts";
export function dollars(value: unknown, max = "5000"): bigint {
  if (typeof value !== "string" || !/^\d{1,9}(\.\d{1,12})?$/.test(value))
    throw new Error(
      "Use a non-negative decimal amount with at most 12 decimal places.",
    );
  const amount = usdToPico(value);
  if (amount > usdToPico(max)) throw new Error(`Amount exceeds ${max} USDG.`);
  return amount;
}
export function providerDollars(value: unknown): bigint | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const s = String(value);
  if (s.length > 64 || !/^\d{1,12}(\.\d{1,30})?(e[+-]?\d{1,2})?$/i.test(s))
    return null;
  try {
    const n = usdToPico(s);
    return n >= 0n && n <= usdToPico("1000000") ? n : null;
  } catch {
    return null;
  }
}
