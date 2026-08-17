import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { base58 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha256";

const words = new Set(wordlist);
const sizes = [12, 15, 18, 21, 24];
const separator =
  /^[\s,;|•·*\-–—'"`[\](){}]*(?:#?\d{1,2}[.):]?[\s,;|•·*\-–—'"`[\](){}]*)?$/;
const curveOrder = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);
export type SecretHit = { kind: "seed" | "key" | "hex" };

/** Bounded rolling windows avoid quadratic scans on long dictionary-only input. */
export function findSeedPhrase(text: string): SecretHit | null {
  let run: string[] = [],
    end = 0;
  for (const match of text.matchAll(/[A-Za-z]+/g)) {
    const token = match[0].toLowerCase();
    const gap = text.slice(end, match.index);
    if (!words.has(token)) run = [];
    else {
      if (gap.length > 64 || !separator.test(gap)) run = [];
      run.push(token);
      if (run.length > 24) run.shift();
      for (const size of sizes)
        if (
          size <= run.length &&
          validateMnemonic(run.slice(-size).join(" "), wordlist)
        )
          return { kind: "seed" };
    }
    end = match.index + match[0].length;
  }
  return null;
}

function checkedPayload(encoded: string): Uint8Array | null {
  try {
    const bytes = base58.decode(encoded);
    if (bytes.length < 5) return null;
    const payload = bytes.subarray(0, -4),
      checksum = sha256(sha256(payload));
    return checksum
      .subarray(0, 4)
      .every((value, index) => value === bytes[bytes.length - 4 + index])
      ? payload
      : null;
  } catch {
    return null;
  }
}
function validScalar(bytes: Uint8Array) {
  let scalar = 0n;
  for (const byte of bytes) scalar = scalar * 256n + BigInt(byte);
  return scalar > 0n && scalar < curveOrder;
}
export function findPrivateKey(text: string): SecretHit | null {
  for (const match of text.matchAll(
    /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{51,116}(?![1-9A-HJ-NP-Za-km-z])/g,
  )) {
    const payload = checkedPayload(match[0]);
    if (!payload) continue;
    if (
      (payload[0] === 0x80 || payload[0] === 0xef) &&
      (payload.length === 33 || (payload.length === 34 && payload[33] === 1)) &&
      validScalar(payload.subarray(1, 33))
    )
      return { kind: "key" };
    if (
      /^[xtyzuvYZ]prv/.test(match[0]) &&
      payload.length === 78 &&
      payload[45] === 0 &&
      validScalar(payload.subarray(46))
    )
      return { kind: "key" };
  }
  return null;
}


