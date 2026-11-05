import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../server/config.ts";
import {
  createProvider,
  reportedCost,
  catalogCost,
  catalogPricing,
} from "../server/provider.ts";
import { normalizeProviderUsage } from "../shared/provider-usage.ts";
import { dollars } from "../shared/money.ts";
import { chat } from "./fixture.ts";
const cfg = config({
  PROVIDER_API_KEY: "test-only",
  PROVIDER_BASE_URL: "https://gateway.example.invalid",
});
const prices = {
  type: "per_token",
  currency: "USD",
  input_per_1M_tokens: 0.15825,
  output_per_1M_tokens: 0.633,
  cache_read_per_1M_tokens: 0.079125,
  cache_write_per_1M_tokens: 0.15825,
  reasoning_per_1M_tokens: 0.633,
};
const meteredUsage = {
  prompt_tokens: 12,
  completion_tokens: 2,
  total_tokens: 14,
  prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 0 },
};
test("billing rates: published prices reproduce the recorded charge without adding supplier fees twice", () => {
  assert.equal(catalogCost(meteredUsage, prices), dollars("0.000003165"));
  assert.equal(
    catalogCost(
      { ...meteredUsage, prompt_tokens_details: { cached_tokens: 4 } },
      prices,
    ),
    dollars("0.0000028485"),
  );
  assert.equal(
    catalogCost(
      { ...meteredUsage, completion_tokens_details: { reasoning_tokens: 1 } },
      { ...prices, reasoning_per_1M_tokens: 1 },
    ),
    dollars("0.000003532"),
  );
  assert.equal(
    catalogCost(
      {
        ...meteredUsage,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 3 },
      },
      { ...prices, cache_write_per_1M_tokens: 1 },
    ),
    dollars("0.00000569025"),
  );
  assert.equal(
    catalogCost(
      { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      prices,
    ),
    0n,
  );
});
test("billing rates: incomplete or ambiguous metering cannot finalize a charge", () => {
  for (const usage of [
    null,
    {},
    { ...meteredUsage, total_tokens: 15 },
    { ...meteredUsage, prompt_tokens_details: {} },
    { ...meteredUsage, prompt_tokens: 1.2 },
    { ...meteredUsage, is_byok: true },
    { ...meteredUsage, prompt_tokens_details: { cached_tokens: 13 } },
    {
      ...meteredUsage,
      prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 3 },
    },
    { ...meteredUsage, completion_tokens_details: { reasoning_tokens: 3 } },
    { ...meteredUsage, prompt_tokens_details: { audio_tokens: 1 } },
    { ...meteredUsage, search_requests: 1 },
    { ...meteredUsage, completion_tokens_details: { reasoning_tokens: -1 } },
  ]) {
    assert.equal(catalogCost(usage, prices), null);
  }
  assert.equal(
    catalogCost(
      { ...meteredUsage, prompt_tokens_details: { cached_tokens: 1 } },
      { ...prices, cache_read_per_1M_tokens: undefined },
    ),
    null,
  );
  assert.equal(catalogPricing({ ...prices, currency: "EUR" }), null);
  assert.equal(catalogPricing({ ...prices, request_fee: 1 }), null);
  assert.equal(catalogPricing({ ...prices, input_per_1M_tokens: -1 }), null);
  assert.equal(catalogCost(meteredUsage, null), null);
});
test("billing rates: streaming uses frozen quote rates, preserves reported cost, and rejects interruption", async () => {
  const snapshot = catalogPricing(prices)!;
  const p = createProvider(cfg, async () =>
    sse([
      {
        id: "billing",
        choices: [{ delta: { content: "OK" } }],
        usage: meteredUsage,
      },
    ]),
  );
  const result = await p.complete(chat, undefined, snapshot);
  assert.equal(result.cost, dollars("0.000003165"));
  assert.equal(result.costBasis, "published_rates");
  assert.equal((await p.complete(chat)).cost, null);
  const reported = await createProvider(cfg, async () =>
    sse([{ usage: meteredUsage, cost: 0.000001 }]),
  ).complete(chat, undefined, snapshot);
  assert.equal(reported.cost, dollars("0.000001"));
  assert.equal(reported.costBasis, "reported");
  const invalid = await createProvider(cfg, async () =>
    sse([{ usage: meteredUsage, cost: -1 }]),
  ).complete(chat, undefined, snapshot);
  assert.equal(invalid.cost, null);
  await assert.rejects(
    createProvider(cfg, async () =>
      sse([{ usage: meteredUsage }], false),
    ).complete(chat, undefined, snapshot),
    { code: "provider_interrupted", uncertain: true },
  );
});
function sse(events: any[], done = true) {
  return new Response(
    events.map((x) => `data: ${JSON.stringify(x)}\n\n`).join("") +
      (done ? "data: [DONE]\n\n" : ""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
test("PROVIDER: explicit total takes precedence and BYOK fee is not treated as full inference cost", () => {
  assert.equal(
    reportedCost(
      { cost: 1, cost_details: { upstream_inference_cost: 2 } },
      3,
      550,
    ),
    dollars("3"),
  );
  assert.equal(
    reportedCost(
      {
        is_byok: true,
        cost: 0.05,
        cost_details: { upstream_inference_cost: 1 },
      },
      null,
      550,
    ),
    dollars("1.055"),
  );
  assert.equal(reportedCost({ is_byok: true, cost: 0.05 }, null, 550), null);
  assert.equal(reportedCost({ cost: 1 }, null, 550), dollars("1.055"));
  assert.equal(reportedCost({ cost: -1 }, null, 550), null);
});
test("PROVIDER: explicit reasoning normalization is narrow and idempotent", () => {
  const usage = {
    prompt_tokens: 10,
    completion_tokens: 20,
    total_tokens: 35,
    completion_tokens_details: { reasoning_tokens: 5 },
    extra_properties: { google: {} },
  };
  const normalized = normalizeProviderUsage(usage, "exclusive");
  assert.equal(normalized.completion_tokens, 25);
  assert.deepEqual(normalizeProviderUsage(normalized, "exclusive"), normalized);
  assert.equal(
    normalizeProviderUsage(usage, "inclusive").completion_tokens,
    20,
  );
  assert.equal(
    normalizeProviderUsage({ ...usage, total_tokens: 30 }, "exclusive")
      .completion_tokens,
    20,
  );
});
test("PROVIDER: SSE uses final cumulative usage once and requires completion marker", async () => {
  let sent: any;
  const p = createProvider(cfg, async (url, options) => {
    sent = { url, options };
    return sse([
      {
        id: "a",
        choices: [{ delta: { content: "Hello " } }],
        usage: { cost: 0.1 },
      },
      { choices: [{ delta: { content: "world" } }], usage: { cost: 0.2 } },
    ]);
  });
  const result = await p.complete(chat);
  assert.equal(result.content, "Hello world");
  assert.equal(result.cost, dollars("0.211"));
  assert.equal(sent.url, "https://gateway.example.invalid/chat/completions");
  assert.equal(
    JSON.parse(sent.options.body).stream_options.include_usage,
    true,
  );
  await assert.rejects(
    createProvider(cfg, async () =>
      sse([{ choices: [{ delta: { content: "partial" } }] }], false),
    ).complete(chat),
    { code: "provider_interrupted", uncertain: true },
  );
  await assert.rejects(
    createProvider(cfg, async () => new Response("", { status: 429 })).complete(
      chat,
    ),
    { uncertain: false },
  );
  await assert.rejects(
    createProvider(cfg, async () => new Response("", { status: 502 })).complete(
      chat,
    ),
    { uncertain: true },
  );
});
test("PROVIDER: unpriced models and unverified retention claims are refused", async () => {
  const p = createProvider(cfg, async () =>
    Response.json({
      data: [
        {
          id: "valid",
          type: "chat",
          pricing: {
            type: "per_token",
            currency: "USD",
            input_per_1M_tokens: 1,
            output_per_1M_tokens: 2,
          },
        },
        { id: "unknown", type: "chat" },
      ],
    }),
  );
  assert.equal((await p.catalog()).length, 1);
  await assert.rejects(p.estimate({ ...chat, model: "unknown" }), {
    code: "model_unavailable",
  });
  await assert.rejects(
    p.estimate({ ...chat, model: "valid", lane: "zero_retention" }),
    { code: "privacy_unavailable" },
  );
});
