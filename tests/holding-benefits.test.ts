import { test } from "node:test";
import assert from "node:assert/strict";
import {
  minimumHolding,
  tokenHoldingWindow,
} from "../server/token-holdings.ts";
import { fixture, chat } from "./fixture.ts";
import { config } from "../server/config.ts";
const safe = "0x0000000000000000000000000000000000000001",
  other = "0x0000000000000000000000000000000000000002";
const log = (i: number, from: string, to: string, value: bigint) => ({
  blockNumber: 10n,
  logIndex: i,
  transactionHash: "0xabc",
  args: { from, to, value },
  removed: false,
});
test("Holding benefits: same-block out-and-back movement lowers the window minimum and self-transfers are deduplicated", () => {
  const outgoing = log(1, safe, other, 100n),
    incoming = log(2, other, safe, 100n),
    self = log(3, safe, safe, 50n);
  assert.equal(
    minimumHolding(100n, 100n, safe, [outgoing, incoming, self, self]),
    0n,
  );
  assert.equal(
    minimumHolding(0n, 100n, other, [log(1, safe, other, 100n)]),
    0n,
  );
  assert.throws(() => minimumHolding(100n, 100n, safe, [outgoing]));
});
test("Holding benefits: historical reads are block-bound and history failures do not grant a discount", async (t) => {
  const reader = {
    getBlock: async (p: any) => ({
      number: p.blockNumber ?? 100n,
      timestamp: (p.blockNumber ?? 100n) * 1000n,
      hash: "0xanchor",
    }),
    readContract: async (p: any) =>
      p.functionName === "decimals" ? 18 : 25000000n * 10n ** 18n,
    getLogs: async () => [],
  };
  const result = await tokenHoldingWindow(reader, other, safe);
  assert.equal(result.eligibleBalance, 25000000n * 10n ** 18n);
  const r = await fixture("token_benefits");
  t.after(() => r.db.close());
  const u = await r.login(),
    o = await r.office(u.account);
  r.chain.tokenHoldingWindow = async () => {
    throw Error("history unavailable");
  };
  assert.equal(await r.ledger.discount(o.access), 0);
  assert.equal(
    (await r.updates.benefits(o.access)).status,
    "history_unavailable",
  );
  assert.equal(
    (await r.ledger.quote(o.access, chat)).envelope.payload.discountBps,
    0,
  );
});
test("Token configuration: CCRY and legacy addresses must agree", () => {
  assert.equal(config({ CCRY_TOKEN_ADDRESS: safe }).tokenAddress, safe);
  assert.equal(config({ CHNC_TOKEN_ADDRESS: safe }).tokenAddress, safe);
  assert.throws(
    () => config({ CCRY_TOKEN_ADDRESS: safe, CHNC_TOKEN_ADDRESS: other }),
    /disagree/,
  );
});
