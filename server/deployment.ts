import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { getAddress, keccak256, parseAbi, type Address, type Hex } from "viem";
import { ADDRESSES, registryAbi, safeAbi, ZERO } from "../shared/chain.ts";
import { runtimeMatches } from "./bytecode.ts";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((v) => !/^0x0{40}$/i.test(v), "Zero address is not a deployment")
  .transform((v) => getAddress(v));
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const multisig = z.strictObject({
  owners: z.array(address).min(2),
  threshold: z.number().int().min(2),
  extensions: z.literal("none"),
}).refine((v) => v.threshold <= v.owners.length && new Set(v.owners).size === v.owners.length,
  "Multisig owners must be distinct and meet the threshold");
export const deploymentManifest = z.strictObject({
  version: z.literal(1), chainId: z.literal(4663),
  registry: address, settlementLog: address, administrator: address,
  treasury: address, operator: address,
  token: address.refine((v) => v.toLowerCase() === ADDRESSES.usdg.toLowerCase()),
  allowanceModule: address.refine((v) => v.toLowerCase() === ADDRESSES.allowanceModule.toLowerCase()),
  sourceSha256: hash,
  registryArtifactSha256: hash, logArtifactSha256: hash,
  administratorSafe: multisig, treasurySafe: multisig,
  minimumOperatorWei: z.string().regex(/^[0-9]{1,30}$/),
}).refine((v) => v.administrator !== v.treasury && v.operator !== v.administrator && v.operator !== v.treasury &&
  !v.administratorSafe.owners.includes(v.operator) && !v.treasurySafe.owners.includes(v.operator),
  "Governance, treasury and gas-only operator must be separate");
export type DeploymentManifest = z.infer<typeof deploymentManifest>;
type Artifact = { deployedBytecode: Hex; immutableReferences: Record<string, {start:number;length:number}[]>; sourceSha256: string };
export type DeploymentBuild = {
  registry: Artifact; log: Artifact; proxyRuntime: Hex; moduleRuntimeHash: Hex; singletonRuntimeHash: Hex;
  sourceSha256: string; registryArtifactSha256: string; logArtifactSha256: string;
};
export interface DeploymentReader {
  getChainId(): Promise<number>;
  getBlockNumber(args?: {cacheTime?: number}): Promise<bigint>;
  getCode(args: {address: Address; blockNumber: bigint}): Promise<Hex | undefined>;
  getBalance(args: {address: Address; blockNumber: bigint}): Promise<bigint>;
  getStorageAt(args: {address: Address; slot: Hex; blockNumber: bigint}): Promise<Hex | undefined>;
  readContract(args: {address: Address; abi: any; functionName: string; blockNumber: bigint; args?: readonly unknown[]}): Promise<any>;
}
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const logAbi = parseAbi(["function registry() view returns(address)"]);
const moduleHash = "0x7aa63affdca06fe94576f00077ad61a02ccf203a5da31e1b4ed595df7b65cf3e";
// Canonical v1.4.1 runtime: safe-global/safe-deployments src/assets/v1.4.1/safe.json.
const singletonHash = "0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4";
const extensionAbi = parseAbi(["function getModulesPaginated(address start,uint256 pageSize) view returns(address[] array,address next)"]);
const sentinel = "0x0000000000000000000000000000000000000001";
// Safe v1.4.1 GuardManager and FallbackManager storage slots.
export const safeExtensionSlots = {
  guard: "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8",
  fallbackHandler: "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5",
} as const;

/** Load the build of record; artifacts must also bind to the checked-out source. */
export async function loadDeploymentBuild(): Promise<DeploymentBuild> {
  const [registry, log, proxy, source] = await Promise.all([
    readFile(new URL("../contracts/artifacts/ChanceryRegistry.json", import.meta.url)),
    readFile(new URL("../contracts/artifacts/SettlementLog.json", import.meta.url)),
    readFile(new URL("../contracts/reference/SafeProxy-1.4.1.json", import.meta.url)),
    readFile(new URL("../contracts/src/ChanceryRegistry.sol", import.meta.url)),
  ]);
  return {registry: JSON.parse(registry.toString()), log: JSON.parse(log.toString()),
    proxyRuntime: JSON.parse(proxy.toString()).deployedBytecode, moduleRuntimeHash: moduleHash, singletonRuntimeHash: singletonHash,
    sourceSha256: sha256(source), registryArtifactSha256: sha256(registry), logArtifactSha256: sha256(log)};
}

/** Read-only verification against an independently approved deployment manifest. */
export async function verifyDeployment(input: unknown, reader: DeploymentReader, build: DeploymentBuild) {
  const expected = deploymentManifest.parse(input);
  const fail = (condition: unknown, message: string): void => { if (!condition) throw Error(`Deployment mismatch: ${message}`); };
  for (const field of ["sourceSha256", "registryArtifactSha256", "logArtifactSha256"] as const)
    fail(expected[field] === build[field], field);
  fail(build.registry.sourceSha256 === build.sourceSha256 && build.log.sourceSha256 === build.sourceSha256,
    "artifacts do not match source");
  fail(await reader.getChainId() === expected.chainId, "chain ID");
  const blockNumber = await reader.getBlockNumber({cacheTime: 0});
  const code = (address: Address) => reader.getCode({address, blockNumber});
  const read = (address: Address, abi: any, functionName: string) => reader.readContract({address, abi, functionName, blockNumber});
  const equalAddress = (actual: unknown, wanted: Address, name: string) =>
    fail(typeof actual === "string" && actual.toLowerCase() === wanted.toLowerCase(), name);
  const registryCode = await code(expected.registry);
  fail(registryCode && runtimeMatches(registryCode, build.registry), "registry runtime");
  for (const name of ["token", "allowanceModule", "treasury", "administrator", "operator", "settlementLog"] as const)
    equalAddress(await read(expected.registry, registryAbi, name), expected[name], name);
  const logCode = await code(expected.settlementLog);
  fail(logCode && runtimeMatches(logCode, build.log), "settlement log runtime");
  equalAddress(await read(expected.settlementLog, logAbi, "registry"), expected.registry, "log registry backlink");
  const moduleCode = await code(expected.allowanceModule);
  fail(moduleCode && keccak256(moduleCode) === build.moduleRuntimeHash, "allowance module runtime");
  const tokenCode = await code(expected.token);
  fail(tokenCode && tokenCode !== "0x", "token has no code");
  const singletonCode = await code(ADDRESSES.safeSingleton);
  fail(singletonCode && keccak256(singletonCode) === build.singletonRuntimeHash, "multisig singleton runtime");
  for (const name of ["administrator", "treasury"] as const) {
    const runtime = await code(expected[name]);
    fail(runtime && keccak256(runtime) === keccak256(build.proxyRuntime), `${name} proxy runtime`);
    equalAddress(await read(expected[name], safeAbi, "masterCopy"), ADDRESSES.safeSingleton, `${name} singleton`);
    const owners: Address[] = await read(expected[name], safeAbi, "getOwners");
    const wanted = expected[name === "administrator" ? "administratorSafe" : "treasurySafe"];
    fail(Array.isArray(owners) && owners.length === wanted.owners.length &&
      owners.map((v) => v.toLowerCase()).sort().join() === wanted.owners.map((v) => v.toLowerCase()).sort().join(), `${name} owners`);
    fail(await read(expected[name], safeAbi, "getThreshold") === BigInt(wanted.threshold), `${name} threshold`);
    // Service governance/revenue wallets must have no extension authority. End-user Office wallets are separate.
    const modules = await reader.readContract({address: expected[name], abi: extensionAbi,
      functionName: "getModulesPaginated", args: [sentinel, 1n], blockNumber});
    fail(Array.isArray(modules) && modules.length === 2 && Array.isArray(modules[0]) &&
      modules[0].length === 0 && modules[1] === sentinel, `${name} modules`);
    for (const [extension, slot] of Object.entries(safeExtensionSlots))
      fail(await reader.getStorageAt({address: expected[name], slot, blockNumber}) === ZERO, `${name} ${extension}`);
  }
  const operatorBalance = await reader.getBalance({address: expected.operator, blockNumber});
  fail(operatorBalance >= BigInt(expected.minimumOperatorWei), "operator gas balance");
  return {matches: true, chainId: expected.chainId, blockNumber: blockNumber.toString(),
    registry: expected.registry, sourceSha256: build.sourceSha256, operatorBalanceWei: operatorBalance.toString()};
}
