import { encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from "viem";
import { registryAbi, ZERO_ADDRESS } from "../shared/chain.ts";
import { assert } from "./errors.ts";
import { runtimeMatches } from "./bytecode.ts";
import { loadDeploymentBuild, type DeploymentBuild } from "./deployment.ts";

export interface CollectionReader {
  getChainId(): Promise<number>;
  getBlock(args: {blockTag: "finalized"}): Promise<{number: bigint | null; hash: Hex | null}>;
  getCode(args: {address: Address; blockNumber: bigint}): Promise<Hex | undefined>;
  readContract(args: {address: Address; abi: any; functionName: string; args?: readonly unknown[]; blockNumber: bigint}): Promise<any>;
}
const logAbi = parseAbi(["function registry() view returns(address)", "function recorded(bytes32) view returns(bool)"]);

/** Prove an old charge cannot be collected, using one finalized block and the audited runtimes. */
export async function expiredCollectionProof(reader: CollectionReader, registry: Address, officeId: Hex,
  periodStart: number, batch?: {id: Hex; actorId: Hex}, build?: DeploymentBuild) {
  assert(Number.isSafeInteger(periodStart) && periodStart >= 0, 409, "collection_state_invalid", "Invalid original period.");
  assert(await reader.getChainId() === 4663, 503, "chain_mismatch", "Wrong collection network.");
  const block = await reader.getBlock({blockTag: "finalized"});
  assert(block.number !== null && block.hash !== null, 503, "finality_unavailable", "Finalized collection state is unavailable.");
  const blockNumber = block.number;
  const expected = build ?? await loadDeploymentBuild();
  const code = await reader.getCode({address: registry, blockNumber});
  assert(code && runtimeMatches(code, expected.registry), 503, "collection_code_mismatch", "Registry build does not match.");
  const read = (address: Address, abi: any, functionName: string, args?: readonly unknown[]) =>
    reader.readContract({address, abi, functionName, args, blockNumber});
  const office = await read(registry, registryAbi, "offices", [officeId]);
  assert(office[0]?.toLowerCase() !== ZERO_ADDRESS && /^0x[0-9a-f]{40}$/i.test(office[0]),
    409, "office_missing", "Office does not exist in finalized state.");
  const budget = await read(registry, registryAbi, "budget", [officeId]);
  assert(Number(budget[2]) > periodStart, 409, "period_collectible", "The original allowance period has not expired in finalized state.");
  const log = await read(registry, registryAbi, "settlementLog") as Address;
  const logCode = await reader.getCode({address: log, blockNumber});
  assert(logCode && runtimeMatches(logCode, expected.log), 503, "collection_code_mismatch", "Settlement log build does not match.");
  const backlink = await read(log, logAbi, "registry");
  assert(typeof backlink === "string" && backlink.toLowerCase() === registry.toLowerCase(),
    503, "collection_code_mismatch", "Settlement log Registry does not match.");
  if (batch) {
    const key = keccak256(encodeAbiParameters([{type: "bytes32"}, {type: "bytes32"}, {type: "bytes32"}], [officeId, batch.actorId, batch.id]));
    assert(await read(log, logAbi, "recorded", [key]) === false, 409, "collection_already_paid", "The batch is already paid or its state is unavailable.");
  }
  return {blockNumber: blockNumber.toString(), blockHash: block.hash, periodStart: Number(budget[2])};
}
