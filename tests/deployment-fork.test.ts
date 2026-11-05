import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http, parseAbi, toHex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ADDRESSES, RHC, ZERO, ZERO_ADDRESS, registryAbi } from "../shared/chain.ts";
import { loadDeploymentBuild, verifyDeployment, safeExtensionSlots, type DeploymentReader } from "../server/deployment.ts";

test("Deployment verifier: canonical multisigs on a local fork pass, unexpected extension storage fails", {
  skip: !process.env.LOCAL_FORK_RPC, timeout: 180000,
}, async () => {
  const rpc = process.env.LOCAL_FORK_RPC!;
  assert(["localhost", "127.0.0.1"].includes(new URL(rpc).hostname), "Only a disposable local fork is allowed");
  // Public test-only keys, funded only through the local VM. Never use on a live chain.
  const account = privateKeyToAccount(`0x${"77".repeat(32)}`);
  const other = privateKeyToAccount(`0x${"88".repeat(32)}`);
  const operator = privateKeyToAccount(`0x${"99".repeat(32)}`).address;
  const client = createPublicClient({chain: RHC, transport: http(rpc)});
  const wallet = createWalletClient({chain: RHC, transport: http(rpc), account});
  const local = (method: string, params: unknown[]) => client.request({method, params} as any);
  await local("anvil_setBalance", [account.address, toHex(10n ** 20n)]);
  await local("anvil_setBalance", [operator, toHex(10n ** 18n)]);
  const owners = [account.address, other.address];
  const factoryAbi = parseAbi([
    "function createProxyWithNonce(address singleton,bytes initializer,uint256 saltNonce) returns(address proxy)",
    "event ProxyCreation(address indexed proxy,address singleton)",
  ]);
  const initializer = encodeFunctionData({
    abi: parseAbi(["function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)"]),
    functionName: "setup", args: [owners, 2n, ZERO_ADDRESS, "0x", ZERO_ADDRESS, ZERO_ADDRESS, 0n, ZERO_ADDRESS],
  });
  const wallets: Address[] = [];
  for (let index = 0; index < 2; index++) {
    const tx = await wallet.writeContract({address: ADDRESSES.safeFactory, abi: factoryAbi,
      functionName: "createProxyWithNonce", args: [ADDRESSES.safeSingleton, initializer, BigInt(Date.now()) * 2n + BigInt(index)]});
    const receipt = await client.waitForTransactionReceipt({hash: tx});
    assert.equal(receipt.status, "success");
    const created = receipt.logs.flatMap(log => {
      try {return [decodeEventLog({abi: factoryAbi, data: log.data, topics: log.topics})];} catch {return [];}
    }).find(event => event.eventName === "ProxyCreation");
    assert(created); wallets.push(created.args.proxy);
  }
  const [administrator, treasury] = wallets;
  const artifact = JSON.parse(await readFile(new URL("../contracts/artifacts/ChanceryRegistry.json", import.meta.url), "utf8"));
  const tx = await wallet.deployContract({abi: artifact.abi, bytecode: artifact.bytecode,
    args: [ADDRESSES.usdg, treasury, ADDRESSES.allowanceModule, administrator, operator]});
  const receipt = await client.waitForTransactionReceipt({hash: tx});
  assert.equal(receipt.status, "success"); assert(receipt.contractAddress);
  const registry = receipt.contractAddress;
  const settlementLog = await client.readContract({address: registry, abi: registryAbi, functionName: "settlementLog"});
  const build = await loadDeploymentBuild();
  const manifest = {version: 1, chainId: 4663, registry, settlementLog, administrator, treasury, operator,
    token: ADDRESSES.usdg, allowanceModule: ADDRESSES.allowanceModule,
    sourceSha256: build.sourceSha256, registryArtifactSha256: build.registryArtifactSha256, logArtifactSha256: build.logArtifactSha256,
    administratorSafe: {owners, threshold: 2, extensions: "none"}, treasurySafe: {owners, threshold: 2, extensions: "none"},
    minimumOperatorWei: "1000"};
  assert.equal((await verifyDeployment(manifest, client as DeploymentReader, build)).matches, true);
  for (const [extension, slot] of Object.entries(safeExtensionSlots)) {
    await local("anvil_setStorageAt", [administrator, slot, toHex(1n, {size: 32})]);
    await local("evm_mine", []);
    await assert.rejects(verifyDeployment(manifest, client as DeploymentReader, build), new RegExp(extension));
    await local("anvil_setStorageAt", [administrator, slot, ZERO]);
    await local("evm_mine", []);
  }
  assert.equal((await verifyDeployment(manifest, client as DeploymentReader, build)).matches, true);
});
