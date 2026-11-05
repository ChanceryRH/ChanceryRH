import { z } from "zod";
import { contextEstimate, chatLimits } from "../shared/chat-limits.ts";
import { normalizeProviderUsage } from "../shared/provider-usage.ts";
import { providerDollars, mulBps, picoToUsdString } from "../shared/money.ts";
import { assert } from "./errors.ts";
import type { Config } from "./config.ts";
export const chatSchema = z.strictObject({
  model: z.string().min(1).max(160),
  messages: z
    .array(
      z.strictObject({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().min(1).max(60000),
      }),
    )
    .min(1)
    .max(100),
  maxTokens: z.number().int().min(1).max(8192).default(1024),
  lane: z.enum(["standard", "zero_retention"]).default("standard"),
  conversationId: z.string().max(100).optional(),
  roomId: z.string().max(100).optional(),
});
export type ChatInput = z.infer<typeof chatSchema>;
export class ProviderFailure extends Error {
  code: string;
  uncertain: boolean;
  constructor(code: string, uncertain: boolean) {
    super(code);
    this.code = code;
    this.uncertain = uncertain;
  }
}
export function reportedCost(usage: any, explicit: unknown, feeBps: number) {
  const top = providerDollars(explicit);
  if (top !== null) return top;
  const upstream = providerDollars(
    usage?.cost_details?.upstream_inference_cost,
  );
  if (upstream !== null) return upstream + mulBps(upstream, feeBps);
  const cost = providerDollars(usage?.cost);
  return cost !== null && usage?.is_byok !== true
    ? cost + mulBps(cost, feeBps)
    : null;
}
const rateFields = [
  "input_per_1M_tokens",
  "output_per_1M_tokens",
  "cache_read_per_1M_tokens",
  "cache_write_per_1M_tokens",
  "reasoning_per_1M_tokens",
  "image_input_per_1M_tokens",
] as const;
export type CatalogPricing = { type: "per_token"; currency: "USD" } & Partial<
  Record<(typeof rateFields)[number], string>
>;

/** Freeze only the published USD token rates into the signed quote. */
export function catalogPricing(value: any): CatalogPricing | null {
  if (
    !value ||
    value.type !== "per_token" ||
    value.currency !== "USD" ||
    Object.keys(value).some(
      (k) => !["type", "currency", ...rateFields].includes(k),
    )
  )
    return null;
  const result: CatalogPricing = { type: "per_token", currency: "USD" };
  for (const field of rateFields) {
    if (value[field] === undefined || value[field] === null) continue;
    const rate = providerDollars(value[field]);
    if (rate === null) return null;
    result[field] = picoToUsdString(rate);
  }
  return result.input_per_1M_tokens !== undefined &&
    result.output_per_1M_tokens !== undefined
    ? result
    : null;
}

/** Text-only usage at the quote's rates; unsupported usage remains pending. */
export function catalogCost(usage: any, pricing: unknown): bigint | null {
  const rates = catalogPricing(pricing);
  if (!rates || !usage || usage.is_byok === true) return null;
  const permitted = [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "prompt_tokens_details",
    "completion_tokens_details",
    "extra_properties",
    "is_byok",
  ];
  if (Object.keys(usage).some((k) => !permitted.includes(k))) return null;
  const input = usage.prompt_tokens,
    output = usage.completion_tokens,
    total = usage.total_tokens;
  if (
    ![input, output, total].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    !Number.isSafeInteger(input + output) ||
    total !== input + output
  )
    return null;
  const prompt = usage.prompt_tokens_details ?? {},
    completion = usage.completion_tokens_details ?? {};
  if (
    typeof prompt !== "object" ||
    typeof completion !== "object" ||
    Array.isArray(prompt) ||
    Array.isArray(completion)
  )
    return null;
  for (const [details, allowed] of [
    [prompt, ["cached_tokens", "cache_write_tokens"]],
    [completion, ["reasoning_tokens"]],
  ] as const) {
    if (
      Object.entries(details).some(
        ([k, v]) => !(allowed as readonly string[]).includes(k) && v !== 0,
      )
    )
      return null;
  }
  const read = prompt.cached_tokens ?? 0,
    write = prompt.cache_write_tokens ?? 0,
    reasoning = completion.reasoning_tokens ?? 0;
  // A missing discount count is not proof that every token used the base rate.
  for (const [count, subtotal, rate, base] of [
    [
      prompt.cached_tokens,
      input,
      rates.cache_read_per_1M_tokens,
      rates.input_per_1M_tokens,
    ],
    [
      prompt.cache_write_tokens,
      input,
      rates.cache_write_per_1M_tokens,
      rates.input_per_1M_tokens,
    ],
    [
      completion.reasoning_tokens,
      output,
      rates.reasoning_per_1M_tokens,
      rates.output_per_1M_tokens,
    ],
  ]) {
    if (subtotal && count == null && rate !== undefined && rate !== base)
      return null;
  }
  if (
    ![read, write, reasoning].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    !Number.isSafeInteger(read + write) ||
    read + write > input ||
    reasoning > output
  )
    return null;
  const portions = [
    [input - read - write, "input_per_1M_tokens"],
    [read, "cache_read_per_1M_tokens"],
    [write, "cache_write_per_1M_tokens"],
    [output - reasoning, "output_per_1M_tokens"],
    [reasoning, "reasoning_per_1M_tokens"],
  ] as const;
  let numerator = 0n;
  for (const [tokens, field] of portions) {
    if (!tokens) continue;
    const rate = providerDollars(rates[field]);
    if (rate === null) return null;
    numerator += BigInt(tokens) * rate;
  }
  // Published rates include supplier fees; add no second supplier markup.
  return (numerator + 999999n) / 1000000n;
}

async function boundedJson(response: Response, maximum = 4_000_000) {
  assert(
    response.ok && response.body,
    503,
    "catalog_unavailable",
    "The model catalog is unavailable.",
  );
  const reader = response.body.getReader();
  let n = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      n += r.value.length;
      if (n > maximum) throw Error("Response limit");
      chunks.push(r.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export function createProvider(cfg: Config, fetcher: typeof fetch = fetch) {
  let cached: any[] = [];
  let expires = 0;
  async function models() {
    assert(
      cfg.providerBaseUrl,
      503,
      "provider_unconfigured",
      "The operator must configure PROVIDER_BASE_URL.",
    );
    if (Date.now() < expires) return cached;
    const data = await boundedJson(
      await fetcher(`${cfg.providerBaseUrl.replace(/\/$/, "")}/v1/models`, {
        signal: AbortSignal.timeout(15000),
      }),
    );
    const rows = Array.isArray(data) ? data : data.data || data.models;
    assert(
      Array.isArray(rows),
      503,
      "catalog_invalid",
      "The model catalog is invalid.",
    );
    cached = rows.filter(
      (m: any) =>
        m.type === "chat" &&
        typeof m.id === "string" &&
        (!cfg.modelAllowlist.length || cfg.modelAllowlist.includes(m.id)) &&
        m.pricing?.type === "per_token" &&
        m.pricing?.currency === "USD" &&
        providerDollars(m.pricing.input_per_1M_tokens) !== null &&
        providerDollars(m.pricing.output_per_1M_tokens) !== null,
    );
    expires = Date.now() + 300000;
    return cached;
  }
  async function estimate(input: ChatInput) {
    const model = (await models()).find((m) => m.id === input.model);
    assert(
      model,
      400,
      "model_unavailable",
      "Select a priced model from the current catalog.",
    );
    const limits = chatLimits(model),
      tokens = contextEstimate(input.messages);
    assert(
      input.messages.reduce((n, m) => n + m.content.length, 0) <= 240000,
      400,
      "context_too_large",
      "Message content is too large.",
    );
    assert(
      input.maxTokens <= limits.maxOutputTokens,
      400,
      "output_limit",
      "Requested output exceeds this model’s limit.",
    );
    assert(
      !limits.contextTokens || tokens + input.maxTokens <= limits.contextTokens,
      400,
      "context_too_large",
      "Messages exceed this model’s context limit.",
    );
    assert(
      input.lane !== "zero_retention" ||
        cfg.zeroRetentionModels.includes(input.model),
      400,
      "privacy_unavailable",
      "This model has no operator-verified zero-retention configuration.",
    );
    const inputRate = providerDollars(model.pricing.input_per_1M_tokens)!;
    const outputRate = providerDollars(model.pricing.output_per_1M_tokens)!;
    const reasoningRate =
      providerDollars(model.pricing.reasoning_per_1M_tokens) ?? outputRate;
    const raw =
      (BigInt(tokens) * inputRate +
        BigInt(input.maxTokens) *
          (reasoningRate > outputRate ? reasoningRate : outputRate) +
        999999n) /
      1000000n;
    // Catalog prices may already include the PROVIDER fee. Extra headroom is a reservation, never a charge.
    const providerMaximum = raw + mulBps(raw, cfg.providerFeeBps + 1000);
    return { providerMaximum, inputTokensEstimate: tokens, model };
  }
  async function complete(
    input: ChatInput,
    onDelta?: (text: string) => void,
    quotedPricing?: unknown,
  ) {
    const pricing = catalogPricing(quotedPricing);
    assert(
      cfg.providerKey,
      503,
      "provider_unconfigured",
      "The operator must configure PROVIDER_API_KEY.",
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    let response: Response;
    try {
      response = await fetcher(
        `${cfg.providerBaseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfg.providerKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: input.model,
            messages: input.messages,
            max_tokens: input.maxTokens,
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderFailure(
          `provider_http_${response.status}`,
          ![400, 401, 402, 403, 413, 422, 429].includes(response.status),
        );
      }
      if (!response.body) throw new ProviderFailure("provider_empty", true);
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "",
        content = "",
        reasoning = "",
        id: string | null = null,
        rawUsage: any = null,
        explicit: unknown = null,
        done = false,
        bytes = 0;
      try {
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          bytes += r.value.length;
          if (bytes > 4_000_000)
            throw new ProviderFailure("provider_response_limit", true);
          buffer += decoder.decode(r.value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            if (!line.startsWith("data:")) continue;
            const value = line.slice(5).trim();
            if (value === "[DONE]") {
              done = true;
              continue;
            }
            if (!value) continue;
            let event: any;
            try {
              event = JSON.parse(value);
            } catch {
              throw new ProviderFailure("provider_invalid_stream", true);
            }
            if (event.error)
              throw new ProviderFailure("provider_stream_error", true);
            if (typeof event.id === "string") id = event.id;
            if (event.usage) rawUsage = event.usage;
            if (event.cost !== undefined) explicit = event.cost;
            const delta = event.choices?.[0]?.delta;
            if (typeof delta?.content === "string") {
              content += delta.content;
              onDelta?.(delta.content);
            }
            const thinking = delta?.reasoning_content ?? delta?.reasoning;
            if (typeof thinking === "string") reasoning += thinking;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (!done) throw new ProviderFailure("provider_interrupted", true);
      const usage = normalizeProviderUsage(rawUsage, cfg.reasoningMode);
      const reported = reportedCost(rawUsage, explicit, cfg.providerFeeBps);
      const hasReportedAmount =
        explicit != null ||
        rawUsage?.cost != null ||
        rawUsage?.cost_details != null;
      const calculated =
        reported === null && !hasReportedAmount
          ? catalogCost(usage, pricing)
          : null;
      return {
        content,
        reasoning,
        id,
        rawUsage,
        usage,
        cost: reported ?? calculated,
        costBasis:
          reported !== null
            ? ("reported" as const)
            : calculated !== null
              ? ("published_rates" as const)
              : ("unknown" as const),
      };
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      throw new ProviderFailure("provider_network_uncertain", true);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    models,
    estimate,
    complete,
    async catalog() {
      return (await models()).map((m) => ({
        id: m.id,
        name: m.name || m.id,
        contextLength: chatLimits(m).contextTokens,
        maxTokens: Math.min(8192, chatLimits(m).maxOutputTokens),
        inputUsdPerMillion: picoToUsdString(
          providerDollars(m.pricing.input_per_1M_tokens)!,
        ),
        outputUsdPerMillion: picoToUsdString(
          providerDollars(m.pricing.output_per_1M_tokens)!,
        ),
        lanes: cfg.zeroRetentionModels.includes(m.id)
          ? ["standard", "zero_retention"]
          : ["standard"],
      }));
    },
  };
}
export type Provider = ReturnType<typeof createProvider>;
