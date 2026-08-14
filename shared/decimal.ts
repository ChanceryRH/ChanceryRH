export type Rounding = "ceil" | "floor";
export const PICO_PER_USD = 1_000_000_000_000n;
export const PICO_PER_USDG_UNIT = 1_000_000n;

/** Bounded exact decimal parsing prevents exponent-driven memory exhaustion. */
export function decimalParts(value: string | number | bigint) {
  const text = String(value).trim();
  if (text.length > 128) throw new RangeError("Decimal amount is too long.");
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d{1,3}))?$/i.exec(text);
  if (!match) throw new TypeError("Invalid decimal amount.");
  const exponent = Number(match[4] || 0);
  if (Math.abs(exponent) > 100)
    throw new RangeError("Decimal exponent is out of range.");
  return {
    coefficient: BigInt((match[1] || "") + match[2] + (match[3] || "")),
    scale: (match[3]?.length || 0) - exponent,
  };
}

export function divideRounded(
  numerator: bigint,
  denominator: bigint,
  round: Rounding = "ceil",
) {
  if (denominator <= 0n) throw new RangeError("Divisor must be positive.");
  const quotient = numerator / denominator;
  if (numerator % denominator === 0n) return quotient;
  return (
    quotient +
    (round === "ceil" ? (numerator > 0n ? 1n : 0n) : numerator < 0n ? -1n : 0n)
  );
}

export function usdToPico(
  value: string | number | bigint,
  round: Rounding = "ceil",
) {
  const { coefficient, scale } = decimalParts(value);
  return scale <= 12
    ? coefficient * 10n ** BigInt(12 - scale)
    : divideRounded(coefficient, 10n ** BigInt(scale - 12), round);
}



export const picoToUsdg = (amount: bigint, round: Rounding = "ceil") =>
  divideRounded(amount, PICO_PER_USDG_UNIT, round);
export const usdgToPico = (units: bigint) => units * PICO_PER_USDG_UNIT;



/** Stable largest-remainder allocation conserves every integer unit. */

