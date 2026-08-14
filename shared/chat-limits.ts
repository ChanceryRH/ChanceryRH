export const CHAT_SERVICE_OUTPUT = 32768;
export const CHAT_SERVICE_MESSAGES = 200;
export const CHAT_SERVICE_CHARACTERS = 240000;
const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
type CatalogLimits = {
  context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_completion_tokens?: number;
  top_provider?: { context_length?: number; max_completion_tokens?: number };
};
export function chatLimits(model: CatalogLimits = {}) {
  const output = [
    model.max_output_tokens,
    model.max_completion_tokens,
    model.top_provider?.max_completion_tokens,
  ].filter(positiveInteger);
  const context = [
    model.context_length,
    model.max_input_tokens,
    model.top_provider?.context_length,
  ].filter(positiveInteger);
  const contextTokens = context.length ? Math.min(...context) : null;
  return {
    contextTokens,
    maxOutputTokens: Math.min(
      CHAT_SERVICE_OUTPUT,
      output.length ? Math.min(...output) : 8192,
      contextTokens ? Math.max(1, contextTokens - 256) : 8192,
    ),
    outputLimitKnown: output.length > 0,
    outputSource: output.length
      ? "Catalog limit, bounded by the service"
      : "Conservative service limit; provider output limit unavailable",
    maxMessages: CHAT_SERVICE_MESSAGES,
    maxCharacters: CHAT_SERVICE_CHARACTERS,
  };
}
const encoder = new TextEncoder();
export function contextEstimate(
  messages: readonly {
    content: string | readonly { type: string; text?: string }[];
  }[],
) {
  let total = 8;
  for (const message of messages) {
    total += 8;
    if (typeof message.content === "string")
      total += encoder.encode(message.content).length;
    else
      for (const part of message.content)
        total +=
          part.type === "image_url"
            ? 8192
            : encoder.encode(part.text || "").length;
  }
  return total;
}
