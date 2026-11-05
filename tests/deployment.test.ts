import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, type Address, type Hex } from "viem";
import { ADDRESSES } from "../shared/chain.ts";
import { deploymentManifest, loadDeploymentBuild, verifyDeployment, type DeploymentBuild, type DeploymentReader } from "../server/deployment.ts";
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
function fixture() {
  const digest = "a".repeat(64), registry = address(1), log = address(2), admin = address(3), treasury = address(4);
  const expected = {version: 1, chainId: 4663, registry, settlementLog: log, administrator: admin, treasury,
    operator: address(5), token: ADDRESSES.usdg, allowanceModule: ADDRESSES.allowanceModule,
    sourceSha256: digest, registryArtifactSha256: digest, logArtifactSha256: digest,
    administratorSafe: {owners: [address(10), address(11), address(12)], threshold: 2},
    treasurySafe: {owners: [address(20), address(21)], threshold: 2}, minimumOperatorWei: "100"};
  const artifact = {deployedBytecode: "0x60016000" as Hex, immutableReferences: {"0": [{start: 2, length: 1}]}, sourceSha256: digest};
  const build: DeploymentBuild = {registry: artifact, log: artifact, proxyRuntime: "0x6003", moduleRuntimeHash: keccak256("0x6004"),
    sourceSha256: digest, registryArtifactSha256: digest, logArtifactSha256: digest};
  const codes = new Map<string, Hex>([[registry, "0x6001ff00"], [log, "0x6001ee00"], [admin, "0x6003"],
    [treasury, "0x6003"], [ADDRESSES.allowanceModule, "0x6004"], [ADDRESSES.usdg, "0x6005"]]);
  const calls: bigint[] = [];
  const fields = new Map<string, any>();
  for (const name of ["token", "allowanceModule", "administrator", "treasury", "operator", "settlementLog"] as const)
    fields.set(`${registry}/${name}`, expected[name]);
  fields.set(`${log}/registry`, registry);
  for (const [a,s] of [[admin, expected.administratorSafe], [treasury, expected.treasurySafe]] as const) {
    fields.set(`${a}/masterCopy`, ADDRESSES.safeSingleton);
    fields.set(`${a}/getOwners`, [...s.owners].reverse());
    fields.set(`${a}/getThreshold`, BigInt(s.threshold));
  }
  const reader: DeploymentReader = {
    getChainId: async () => 4663, getBlockNumber: async () => 123n,
    getCode: async ({address, blockNumber}) => {calls.push(blockNumber); return codes.get(address);},
    getBalance: async ({blockNumber}) => {calls.push(blockNumber); return 100n;},
    readContract: async ({address, functionName, blockNumber}) => {calls.push(blockNumber); return fields.get(`${address}/${functionName}`);},
  };
  return {expected, build, reader, calls, codes, fields};
}
test("Deployment verifier: approved runtimes, immutables, multisigs and balances match at one block", async () => {
  const f = fixture();
  const result = await verifyDeployment(f.expected, f.reader, f.build);
  assert.equal(result.matches, true); assert.equal(result.blockNumber, "123");
  assert(f.calls.length > 15 && f.calls.every((n) => n === 123n));
});
test("Deployment verifier: every authority and infrastructure mismatch fails closed", async (t) => {
  for (const name of ["token", "allowanceModule", "treasury", "administrator", "operator", "settlementLog"])
    await t.test(name, async () => {
      const f = fixture(); f.fields.set(`${f.expected.registry}/${name}`, address(99));
      await assert.rejects(verifyDeployment(f.expected, f.reader, f.build), new RegExp(name));
    });
  for (const name of ["registry", "settlementLog", "administrator", "treasury", "allowanceModule", "token"] as const)
    await t.test(`${name} code`, async () => {
      const f = fixture(); f.codes.set(f.expected[name], "0x");
      await assert.rejects(verifyDeployment(f.expected, f.reader, f.build), /Deployment mismatch/);
    });
  for (const name of ["administrator", "treasury"] as const)
    for (const [method, value] of [["masterCopy", address(99)], ["getOwners", [address(99), address(98)]], ["getThreshold", 1n]])
      await t.test(`${name} ${method}`, async () => {
        const f = fixture(); f.fields.set(`${f.expected[name]}/${method}`, value);
        await assert.rejects(verifyDeployment(f.expected, f.reader, f.build), /Deployment mismatch/);
      });
  const backlink = fixture(); backlink.fields.set(`${backlink.expected.settlementLog}/registry`, address(99));
  await assert.rejects(verifyDeployment(backlink.expected, backlink.reader, backlink.build), /backlink/);
});
test("Deployment verifier: wrong build, chain, unavailable reads and low gas are rejected", async () => {
  for (const name of ["sourceSha256", "registryArtifactSha256", "logArtifactSha256"] as const) {
    const f = fixture(); f.expected[name] = "b".repeat(64);
    await assert.rejects(verifyDeployment(f.expected, f.reader, f.build), new RegExp(name));
  }
  const wrongSource = fixture(); wrongSource.build.registry = {...wrongSource.build.registry, sourceSha256: "b".repeat(64)};
  await assert.rejects(verifyDeployment(wrongSource.expected, wrongSource.reader, wrongSource.build), /artifacts/);
  const chain = fixture(); chain.reader.getChainId = async () => 1;
  await assert.rejects(verifyDeployment(chain.expected, chain.reader, chain.build), /chain ID/);
  const gas = fixture(); gas.reader.getBalance = async () => 99n;
  await assert.rejects(verifyDeployment(gas.expected, gas.reader, gas.build), /gas balance/);
  const unavailable = fixture(); unavailable.reader.readContract = async () => {throw Error("offline");};
  await assert.rejects(verifyDeployment(unavailable.expected, unavailable.reader, unavailable.build), /offline/);
});
test("Deployment manifest: empty addresses, weak or duplicate owners and unknown fields are rejected", () => {
  const f = fixture();
  for (const value of [
    {...f.expected, registry: address(0)}, {...f.expected, operator: f.expected.administrator},
    {...f.expected, operator: f.expected.administratorSafe.owners[0]},
    {...f.expected, chainId: 1}, {...f.expected, unknown: true},
    {...f.expected, administratorSafe: {owners: [address(10), address(10)], threshold: 2}},
    {...f.expected, administratorSafe: {owners: [address(10), address(11)], threshold: 1}},
    {...f.expected, administratorSafe: {owners: [address(10), address(11)], threshold: 3}},
  ]) assert.equal(deploymentManifest.safeParse(value).success, false);
});
test("Deployment build: checked-in artifacts bind to source and the canonical module", async () => {
  const build = await loadDeploymentBuild();
  assert.equal(build.registry.sourceSha256, build.sourceSha256);
  assert.equal(build.log.sourceSha256, build.sourceSha256);
  assert.equal(build.moduleRuntimeHash, "0x7aa63affdca06fe94576f00077ad61a02ccf203a5da31e1b4ed595df7b65cf3e");
});
