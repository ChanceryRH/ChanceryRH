import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../server/config.ts";
import { createProvider, reportedCost } from "../server/provider.ts";
import { normalizeProviderUsage } from "../shared/provider-usage.ts";
import { dollars } from "../shared/money.ts";
import { chat } from "./fixture.ts";
const cfg = config({
  PROVIDER_API_KEY: "test-only",
  PROVIDER_BASE_URL: "https://gateway.example.invalid",
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



