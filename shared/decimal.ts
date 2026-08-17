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

export function picoToUsdString(amount: bigint) {
  const absolute = amount < 0n ? -amount : amount;
  const fraction = (absolute % PICO_PER_USD)
    .toString()
    .padStart(12, "0")
    .replace(/0+$/, "");
  return `${amount < 0n ? "-" : ""}${absolute / PICO_PER_USD}${fraction ? `.${fraction}` : ""}`;
}

export const picoToUsdg = (amount: bigint, round: Rounding = "ceil") =>
  divideRounded(amount, PICO_PER_USDG_UNIT, round);
export const usdgToPico = (units: bigint) => units * PICO_PER_USDG_UNIT;

export function mulBps(
  amount: bigint,
  bps: number | bigint,
  round: Rounding = "ceil",
) {
  if (typeof bps === "number" && !Number.isSafeInteger(bps))
    throw new RangeError("Basis points must be an integer.");
  return divideRounded(amount * BigInt(bps), 10_000n, round);
}

/** Stable largest-remainder allocation conserves every integer unit. */
export function allocate(total: bigint, weights: bigint[]) {
  if (total < 0n || weights.some((weight) => weight < 0n))
    throw new RangeError("Allocations must be non-negative.");
  if (!weights.length) {
    if (total) throw new RangeError("A nonzero total needs a recipient.");
    return [];
  }
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (!sum) return weights.map((_, index) => (index === 0 ? total : 0n));
  const result = weights.map((weight) => (total * weight) / sum);
  const remaining = Number(total - result.reduce((a, b) => a + b, 0n));
  const ranked = weights
    .map((weight, index) => ({ index, remainder: (total * weight) % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.index - b.index
        : a.remainder > b.remainder
          ? -1
          : 1,
    );
  for (let i = 0; i < remaining; i++) result[ranked[i].index]++;
  return result;
}
