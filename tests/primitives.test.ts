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
test("canonical records preserve dangerous property names without prototype mutation", () => {
  const input = JSON.parse('{"z":1,"__proto__":{"admin":true},"a":2}');
  assert.equal(
    canonicalJson(input),
    '{"__proto__":{"admin":true},"a":2,"z":1}',
  );
  assert.equal(
    canonicalJson({ z: 1n, a: [undefined, 2], ignored: undefined }),
    '{"a":[null,2],"z":"1"}',
  );
});
test("canonical records reject ambiguous objects, accessors and cycles", () => {
  const cycle: any = {};
  cycle.self = cycle;
  for (const input of [
    cycle,
    new Date(),
    { n: NaN },
    {
      get x() {
        throw Error("must not run");
      },
    },
  ])
    assert.throws(() => canonicalJson(input));
});
test("Merkle proofs verify every odd-tree leaf and reject malformed indices", () => {
  const leaves = Array.from({ length: 7 }, (_, i) =>
    keccak256(toHex(`receipt-${i}`)),
  );
  const tree = new MerkleTree(leaves),
    root = tree.root;
  for (let i = 0; i < leaves.length; i++)
    assert(MerkleTree.verify(leaves[i], tree.proof(i), root));
  leaves[0] = keccak256(toHex("mutated"));
  assert.equal(tree.root, root);
  for (const invalid of [-1, 0.5, NaN, Infinity, 7])
    assert.throws(() => tree.proof(invalid));
  assert.equal(MerkleTree.verify("0x12" as Hex, [], root), false);
  assert.throws(() => new MerkleTree([]));
});
test("Clerk caps retain owner-approved decimal precision and exact approval boundaries", () => {
  const rule = rulebookSchema.parse({
    models: ["vendor/*"],
    perRequestUsd: "4999.999999999999",
    perHourUsd: "5000",
    perDayUsd: "5000",
    perWeekUsd: "5000",
    askAboveUsd: "0.000000000001",
    maxTokens: 10,
  });
  const usage = { active: true, spent: { hour: 0n, day: 0n, week: 0n } };
  assert.equal(
    evaluateClerkPolicy(rule, usage, {
      model: "vendor/model",
      maximum: 1n,
      maxTokens: 10,
    }).decision,
    "allow",
  );
  assert.equal(
    evaluateClerkPolicy(rule, usage, {
      model: "vendor/model",
      maximum: 2n,
      maxTokens: 10,
    }).decision,
    "approval_required",
  );
  assert.equal(
    evaluateClerkPolicy(rule, usage, {
      model: "vendor/model",
      maximum: usdToPico("5000"),
      maxTokens: 10,
    }).decision,
    "deny",
  );
});
test("Clerk denial takes precedence over approval and invalid accounting fails closed", () => {
  const rule = rulebookSchema.parse({
    models: ["model"],
    perRequestUsd: "1",
    perHourUsd: "1",
    perDayUsd: "1",
    perWeekUsd: "1",
  });
  const usage = { active: false, spent: { hour: 0n, day: 0n, week: 0n } };
  assert.equal(
    evaluateClerkPolicy(rule, usage, {
      model: "model",
      maximum: 1n,
      maxTokens: 10,
    }).decision,
    "deny",
  );
  assert.throws(() =>
    evaluateClerkPolicy(rule, usage, {
      model: "model",
      maximum: -1n,
      maxTokens: 10,
    }),
  );
});







