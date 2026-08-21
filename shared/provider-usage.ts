export type ReasoningMode = "inclusive" | "exclusive";
/** Reconcile explicitly configured exclusive reasoning counts without mutating billing evidence. */
export function normalizeProviderUsage(
  usage: any,
  mode: ReasoningMode = "inclusive",
) {
  if (mode !== "exclusive" || !usage || typeof usage !== "object") return usage;
  const counts = [
    usage.prompt_tokens,
    usage.completion_tokens,
    usage.completion_tokens_details?.reasoning_tokens,
    usage.total_tokens,
  ];
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0))
    return usage;
  const [input, output, reasoning, total] = counts;
  const combined = output + reasoning;
  if (
    reasoning === 0 ||
    !Number.isSafeInteger(combined) ||
    !Number.isSafeInteger(input + combined) ||
    input + combined !== total
  )
    return usage;
  return { ...usage, completion_tokens: combined };
}
