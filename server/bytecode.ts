import { readFile } from "node:fs/promises";
import { keccak256, type Hex } from "viem";
export function runtimeMatches(
  actual: Hex,
  artifact: {
    deployedBytecode: Hex;
    immutableReferences: Record<string, { start: number; length: number }[]>;
  },
) {
  const expected = Buffer.from(artifact.deployedBytecode.slice(2), "hex"),
    received = Buffer.from(actual.slice(2), "hex");
  if (expected.length !== received.length) return false;
  for (const slots of Object.values(artifact.immutableReferences))
    for (const slot of slots) {
      expected.fill(0, slot.start, slot.start + slot.length);
      received.fill(0, slot.start, slot.start + slot.length);
    }
  return keccak256(expected) === keccak256(received);
}
let registryArtifact: any;
export async function verifyRegistryRuntime(actual: Hex) {
  registryArtifact ??= JSON.parse(
    await readFile(
      new URL("../contracts/artifacts/ChanceryRegistry.json", import.meta.url),
      "utf8",
    ),
  );
  return runtimeMatches(actual, registryArtifact);
}
