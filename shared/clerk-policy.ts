import { z } from "zod";
import { dollars } from "./money.ts";

const amount = (positive: boolean) =>
  z.string().refine((value) => {
    try {
      return dollars(value) >= (positive ? 1n : 0n);
    } catch {
      return false;
    }
  }, "Use a decimal USD amount within the Office limit.");

export const rulebookSchema = z.strictObject({
  models: z.array(z.string().min(1).max(160)).min(1).max(64),
  perRequestUsd: amount(true),
  perHourUsd: amount(true),
  perDayUsd: amount(true),
  perWeekUsd: amount(true),
  askAboveUsd: amount(false).default("0"),
  maxTokens: z.number().int().min(1).max(8192).default(1024),
});
export type Rulebook = z.infer<typeof rulebookSchema>;
export type ClerkUsage = {
  active: boolean;
  spent: { hour: bigint; day: bigint; week: bigint };
};
export type ClerkIntent = { model: string; maximum: bigint; maxTokens: number };
export type ClerkDecision = {
  decision: "allow" | "deny" | "approval_required";
  reasons: { code: string; message: string }[];
};

/** Evaluate the same exact decimal amounts that owners approved. */
export function evaluateClerkPolicy(
  rulebook: Rulebook,
  usage: ClerkUsage,
  intent: ClerkIntent,
): ClerkDecision {
  const rule = rulebookSchema.parse(rulebook);
  const reasons: ClerkDecision["reasons"] = [];
  const add = (code: string, message: string) =>
    reasons.push({ code, message });
  if (
    intent.maximum < 0n ||
    Object.values(usage.spent).some((value) => value < 0n) ||
    !Number.isSafeInteger(intent.maxTokens) ||
    intent.maxTokens < 1
  )
    throw new RangeError(
      "Clerk usage and request estimates must be non-negative and bounded.",
    );
  if (!usage.active) add("killed", "This Clerk is not active.");
  if (
    !rule.models.some(
      (pattern) =>
        pattern === intent.model ||
        (pattern.endsWith("/*") &&
          intent.model.startsWith(pattern.slice(0, -1))),
    )
  )
    add("model_not_allowed", "The model is outside the rulebook.");
  if (intent.maximum > dollars(rule.perRequestUsd))
    add("over_per_request", "The request exceeds its cost cap.");
  for (const [window, cap] of [
    ["hour", rule.perHourUsd],
    ["day", rule.perDayUsd],
    ["week", rule.perWeekUsd],
  ] as const)
    if (usage.spent[window] + intent.maximum > dollars(cap))
      add(`over_per_${window}`, `The rolling ${window} cap would be exceeded.`);
  if (intent.maxTokens > rule.maxTokens)
    add("max_tokens", "The output token cap would be exceeded.");
  if (reasons.length) return { decision: "deny", reasons };
  if (intent.maximum > dollars(rule.askAboveUsd))
    return {
      decision: "approval_required",
      reasons: [
        {
          code: "approval_required",
          message: "This cost requires principal approval.",
        },
      ],
    };
  return { decision: "allow", reasons };
}
