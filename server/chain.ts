import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  encodePacked,
  concat,
  keccak256,
  encodeAbiParameters,
  parseAbi,
  recoverTypedDataAddress,
  verifyMessage,
  decodeEventLog,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ADDRESSES,
  RHC,
  ZERO,
  ZERO_ADDRESS,
  safeAbi,
  registryAbi,
  allowanceAbi,
  delegateAbi,
  tokenAbi,
  type SafeTransaction,
} from "../shared/chain.ts";
import type { Config } from "./config.ts";
import { verifyRegistryRuntime } from "./bytecode.ts";
import { ApiError, assert } from "./errors.ts";
export type Call = { to: Address; data: Hex; value?: string };
export type SafeInfo = {
  address: Address;
  owners: Address[];
  threshold: number;
  nonce: string;
  block: string;
  moduleEnabled: boolean;
};
export type OfficeSnapshot = {
  id: Hex;
  safe: Address;
  seatRoot: Hex;
  policyHash: Hex;
  capUnits: bigint;
  spentUnits: bigint;
  periodStart: number;
  active: boolean;
  delegate: Address;
  actorActive: boolean;
  allowanceUnits: bigint;
  allowanceSpentUnits: bigint;
  allowancePeriod: number;
  allowanceInterval: number;
  safeBalanceUnits: bigint;
  owners: Address[];
  threshold: number;
  moduleEnabled: boolean;
  block: string;
};
export type Chain = ReturnType<typeof createChain>;
import { safeTypedTypes, encodeSafeExecution } from "../shared/safe-signing.ts";
export { safeTypedTypes } from "../shared/safe-signing.ts";
export function officeIdFor(safe: Address) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }],
      [4663n, safe],
    ),
  );
}
export function seatLeaf(
  credential: string,
  role: string,
  capPico: string,
  expiresAt: string | null,
) {
  const inner = keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "string" },
        { type: "uint256" },
        { type: "uint64" },
      ],
      [
        credential,
        role,
        BigInt(capPico),
        expiresAt
          ? BigInt(Math.floor(new Date(expiresAt).getTime() / 1000))
          : 0n,
      ],
    ),
  );
  return keccak256(inner);
}
export function typedSafeMessage(tx: SafeTransaction) {
  return {
    ...tx,
    value: BigInt(tx.value),
    safeTxGas: BigInt(tx.safeTxGas),
    baseGas: BigInt(tx.baseGas),
    gasPrice: BigInt(tx.gasPrice),
    nonce: BigInt(tx.nonce),
  };
}
export function createChain(cfg: Config) {
  const client = createPublicClient({
    chain: RHC,
    transport: http(cfg.rpc, { timeout: 15000, retryCount: 1 }),
  });
  const registry = () => {
    assert(
      cfg.registry,
      503,
      "chain_unconfigured",
      "Deploy and configure the Chancery Registry first.",
    );
    return cfg.registry;
  };
  let proxyHash: Hex | undefined;
  async function safe(address: Address): Promise<SafeInfo> {
    assert(
      (await client.getChainId()) === 4663,
      503,
      "wrong_chain",
      "The configured RPC is not Robinhood Chain mainnet.",
    );
    if (!proxyHash) {
      const artifact = JSON.parse(
        await readFile(
          new URL(
            "../contracts/reference/SafeProxy-1.4.1.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      proxyHash = keccak256(artifact.deployedBytecode);
    }
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const code = await client.getCode({ address, blockNumber });
    assert(
      code && keccak256(code) === proxyHash,
      400,
      "safe_unsupported",
      "Use a canonical Safe v1.4.1 proxy on Robinhood Chain.",
    );
    const singleton = await client.readContract({
      address,
      abi: safeAbi,
      functionName: "masterCopy",
      blockNumber,
    });
    assert(
      singleton.toLowerCase() === ADDRESSES.safeSingleton.toLowerCase(),
      400,
      "safe_unsupported",
      "This Safe singleton is not supported.",
    );
    const [owners, threshold, nonce, moduleEnabled] = await Promise.all([
      client.readContract({
        address,
        abi: safeAbi,
        functionName: "getOwners",
        blockNumber,
      }),
      client.readContract({
        address,
        abi: safeAbi,
        functionName: "getThreshold",
        blockNumber,
      }),
      client.readContract({
        address,
        abi: safeAbi,
        functionName: "nonce",
        blockNumber,
      }),
      client.readContract({
        address,
        abi: safeAbi,
        functionName: "isModuleEnabled",
        args: [ADDRESSES.allowanceModule],
        blockNumber,
      }),
    ]);
    return {
      address,
      owners: owners.map((x) => x.toLowerCase() as Address),
      threshold: Number(threshold),
      nonce: nonce.toString(),
      block: blockNumber.toString(),
      moduleEnabled,
    };
  }
  async function snapshot(
    id: Hex,
    actorId: Hex = ZERO,
  ): Promise<OfficeSnapshot> {
    assert(
      (await client.getChainId()) === 4663,
      503,
      "wrong_chain",
      "The configured RPC is not Robinhood Chain mainnet.",
    );
    const r = registry(),
      blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const read = (fn: string, args: any[]) =>
      client.readContract({
        address: r,
        abi: registryAbi,
        functionName: fn as any,
        args,
        blockNumber,
      } as any) as Promise<any>;
    const [o, b, d, actorActive] = await Promise.all([
      read("offices", [id]),
      read("budget", [id]),
      read("delegates", [id, actorId]),
      read("actorActive", [id, actorId]),
    ]);
    assert(
      o[0] !== ZERO_ADDRESS,
      404,
      "office_not_onchain",
      "Office is not registered onchain.",
    );
    const a = o[0] as Address;
    const [allowance, balance, owners, threshold, moduleEnabled] =
      await Promise.all([
        client.readContract({
          address: ADDRESSES.allowanceModule,
          abi: allowanceAbi,
          functionName: "getTokenAllowance",
          args: [a, d, ADDRESSES.usdg],
          blockNumber,
        }),
        client.readContract({
          address: ADDRESSES.usdg,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [a],
          blockNumber,
        }),
        client.readContract({
          address: a,
          abi: safeAbi,
          functionName: "getOwners",
          blockNumber,
        }),
        client.readContract({
          address: a,
          abi: safeAbi,
          functionName: "getThreshold",
          blockNumber,
        }),
        client.readContract({
          address: a,
          abi: safeAbi,
          functionName: "isModuleEnabled",
          args: [ADDRESSES.allowanceModule],
          blockNumber,
        }),
      ]);
    return {
      id,
      safe: a,
      seatRoot: o[1],
      policyHash: o[2],
      capUnits: b[0],
      spentUnits: b[1],
      periodStart: Number(b[2]),
      active: o[6],
      delegate: d,
      actorActive,
      allowanceUnits: allowance[0],
      allowanceSpentUnits: allowance[1],
      allowancePeriod: Number(allowance[3]),
      allowanceInterval: Number(allowance[2]),
      safeBalanceUnits: balance,
      owners: owners.map((x) => x.toLowerCase() as Address),
      threshold: Number(threshold),
      moduleEnabled,
      block: blockNumber.toString(),
    };
  }
  async function prepare(safeAddress: Address, calls: Call[]) {
    assert(
      calls.length > 0 && calls.length <= 100,
      400,
      "batch_invalid",
      "The Safe batch is empty or too large.",
    );
    const info = await safe(safeAddress);
    const packed = concat(
      calls.map((c) =>
        encodePacked(
          ["uint8", "address", "uint256", "uint256", "bytes"],
          [
            0,
            c.to,
            BigInt(c.value || "0"),
            BigInt((c.data.length - 2) / 2),
            c.data,
          ],
        ),
      ),
    );
    const tx: SafeTransaction = {
      to: ADDRESSES.multiSend,
      value: "0",
      data: encodeFunctionData({
        abi: parseAbi(["function multiSend(bytes transactions)"]),
        functionName: "multiSend",
        args: [packed],
      }),
      operation: 1,
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      gasToken: ZERO_ADDRESS,
      refundReceiver: ZERO_ADDRESS,
      nonce: info.nonce,
    };
    const safeTxHash = await client.readContract({
      address: safeAddress,
      abi: safeAbi,
      functionName: "getTransactionHash",
      args: [
        tx.to,
        0n,
        tx.data,
        1,
        0n,
        0n,
        0n,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        BigInt(tx.nonce),
      ],
    });
    return {
      safe: info,
      transaction: tx,
      safeTxHash,
      typedData: {
        domain: { chainId: 4663, verifyingContract: safeAddress },
        types: safeTypedTypes,
        primaryType: "SafeTx",
        message: tx,
      },
    };
  }
  return {
    client,
    safe,
    snapshot,
    prepare,
    
    
    
    
    
    
    
    
    
    
    
    async broadcast(raw: Hex) {
      return client.sendRawTransaction({ serializedTransaction: raw });
    },
    async receipt(txHash: Hex) {
      return client.getTransactionReceipt({ hash: txHash });
    },
  };
}
