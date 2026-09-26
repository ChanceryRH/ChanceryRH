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














