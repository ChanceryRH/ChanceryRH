import { concat, keccak256, type Hex } from "viem";

function digest(value: Hex): Hex {
  if (!/^0x[\da-f]{64}$/i.test(value))
    throw new TypeError("Merkle values must be 32-byte hashes.");
  return value.toLowerCase() as Hex;
}
function pair(left: Hex, right: Hex): Hex {
  return keccak256(concat(left < right ? [left, right] : [right, left]));
}
/** Sorted-pair hashes, with an unpaired last node promoted unchanged. */
export class MerkleTree {
  readonly leaves: readonly Hex[];
  readonly layers: readonly (readonly Hex[])[];
  constructor(leaves: readonly Hex[]) {
    if (!leaves.length)
      throw new RangeError("A receipt tree needs at least one leaf.");
    const levels: Hex[][] = [leaves.map(digest)];
    while (levels.at(-1)!.length > 1) {
      const previous = levels.at(-1)!;
      const next: Hex[] = [];
      for (let index = 0; index < previous.length; index += 2)
        next.push(
          index + 1 < previous.length
            ? pair(previous[index], previous[index + 1])
            : previous[index],
        );
      levels.push(next);
    }
    this.layers = Object.freeze(levels.map((level) => Object.freeze(level)));
    this.leaves = this.layers[0];
  }
  get root(): Hex {
    return this.layers.at(-1)![0];
  }
  proof(index: number): Hex[] {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= this.leaves.length
    )
      throw new RangeError("Invalid receipt index.");
    const siblings: Hex[] = [];
    for (const level of this.layers.slice(0, -1)) {
      const sibling = index % 2 ? index - 1 : index + 1;
      if (sibling < level.length) siblings.push(level[sibling]);
      index = Math.floor(index / 2);
    }
    return siblings;
  }
  static verify(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
    try {
      return (
        proof.reduce(
          (hash, sibling) => pair(hash, digest(sibling)),
          digest(leaf),
        ) === digest(root)
      );
    } catch {
      return false;
    }
  }
}
export function receiptLeaf(payload: Uint8Array, signature: Uint8Array): Hex {
  return keccak256(keccak256(concat([payload, signature])));
}
