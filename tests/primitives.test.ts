import { test } from "node:test";
import assert from "node:assert/strict";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { base58 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha256";
import { keccak256, toHex, type Hex } from "viem";
import {
  allocate,
  divideRounded,
  mulBps,
  picoToUsdString,
  usdToPico,
} from "../shared/decimal.ts";
import { canonicalJson } from "../shared/canonical.ts";
import { MerkleTree } from "../shared/merkle.ts";
import { rulebookSchema, evaluateClerkPolicy } from "../shared/clerk-policy.ts";
import {
  findSeedPhrase,
  findHexKey,
  findPrivateKey,
} from "../shared/secret-scan.ts";
import {
  cleanResponse,
  counterRegressed,
  passkeysAvailable,
} from "../shared/passkey-helpers.ts";
import { normalizeProviderUsage } from "../shared/provider-usage.ts";
import { config } from "../server/config.ts";
import { chatLimits, contextEstimate } from "../shared/chat-limits.ts";

test("decimal conversion retains the smallest billing unit and bounds hostile exponents", () => {
  assert.equal(usdToPico("4999.999999999999"), 4999999999999999n);
  assert.equal(usdToPico("1e-13"), 1n);
  assert.equal(usdToPico("-1e-13", "floor"), -1n);
  for (const invalid of [
    "1e999",
    "1e999999999",
    "1".repeat(129),
    "NaN",
    "Infinity",
  ])
    assert.throws(() => usdToPico(invalid));
  for (let i = -1000; i <= 1000; i++)
    assert.equal(usdToPico(picoToUsdString(BigInt(i))), BigInt(i));
});
test("fee rounding obeys floor and ceiling for signed values", () => {
  assert.equal(divideRounded(-11n, 10n, "floor"), -2n);
  assert.equal(divideRounded(-11n, 10n, "ceil"), -1n);
  assert.equal(mulBps(-1n, 1, "floor"), -1n);
  assert.throws(() => mulBps(100n, 0.5));
});
test("allocation conserves totals, resolves ties and rejects invalid weights", () => {
  assert.deepEqual(allocate(5n, [1n, 1n, 1n]), [2n, 2n, 1n]);
  assert.deepEqual(allocate(5n, [0n, 0n]), [5n, 0n]);
  assert.throws(() => allocate(1n, []));
  assert.throws(() => allocate(1n, [-1n, 2n]));
  for (let n = 1; n < 40; n++) {
    const weights = Array.from({ length: n }, (_, i) => BigInt(i + 1));
    const parts = allocate(101n, weights);
    assert.equal(
      parts.reduce((a, b) => a + b, 0n),
      101n,
    );
    assert(parts.every((value) => value >= 0n));
  }
});












