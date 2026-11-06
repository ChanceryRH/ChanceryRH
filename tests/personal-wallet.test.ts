import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  encodeFunctionData,
  encodePacked,
  concat,
  decodeFunctionData,
  keccak256,
  encodeAbiParameters,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  fundingUnits,
  personalInitializer,
  personalDeployment,
  verifyPersonalSafe,
  verifyPersonalTransaction,
  verifyPersonalActivation,
  fundingCall,
  fundingTokenAbi,
  personalFactoryAbi,
} from "../web/personal-wallet.ts";
import { ADDRESSES, RHC, ZERO_ADDRESS, safeAbi } from "../shared/chain.ts";
const owner = "0x1111111111111111111111111111111111111111" as Address;
const safe = "0x2222222222222222222222222222222222222222" as Address;
const registry = "0x3333333333333333333333333333333333333333" as Address;
const delegate = "0x4444444444444444444444444444444444444444" as Address;
test("personal funding rejects ambiguous amounts and encodes only the selected USDG transfer", () => {
  for (const x of [
    "0",
    "-1",
    "1e3",
    "1.001",
    "5001",
    "0.009",
    "001",
    "NaN",
    "Infinity",
  ])
    assert.throws(() => fundingUnits(x));
  assert.equal(fundingUnits("25.50"), 25_500_000n);
  const transfer = decodeFunctionData({
    abi: fundingTokenAbi,
    data: fundingCall(safe, "25.50"),
  });
  assert.deepEqual(transfer.args, [safe, 25_500_000n]);
  const setup = decodeFunctionData({
    abi: parseAbi([
      "function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)",
    ]),
    data: personalInitializer(owner),
  });
  assert.deepEqual(setup.args, [
    [owner],
    1n,
    ZERO_ADDRESS,
    "0x",
    ZERO_ADDRESS,
    ZERO_ADDRESS,
    0n,
    ZERO_ADDRESS,
  ]);
});
test("personal activation rejects unrelated calls, transferred ETH, and a changed budget", () => {
  const allowance = parseAbi([
    "function addDelegate(address delegate)",
    "function setAllowance(address delegate,address token,uint96 allowanceAmount,uint16 resetTimeMin,uint32 resetBaseMin)",
  ]);
  const calls = [
    {
      to: safe,
      data: encodeFunctionData({
        abi: safeAbi,
        functionName: "enableModule",
        args: [ADDRESSES.allowanceModule],
      }),
    },
    {
      to: ADDRESSES.allowanceModule,
      data: encodeFunctionData({
        abi: allowance,
        functionName: "addDelegate",
        args: [delegate],
      }),
    },
    {
      to: ADDRESSES.allowanceModule,
      data: encodeFunctionData({
        abi: allowance,
        functionName: "setAllowance",
        args: [delegate, ADDRESSES.usdg, 25_000_000n, 43200, 0],
      }),
    },
    {
      to: registry,
      data: encodeFunctionData({
        abi: parseAbi([
          "function open(bytes32 seatRoot,bytes32 policyHash,uint96 cap) returns(bytes32)",
        ]),
        functionName: "open",
        args: [toHex(1n, { size: 32 }), toHex(2n, { size: 32 }), 25_000_000n],
      }),
    },
  ];
  const tx = (entries = calls, value = 0n) => ({
    to: ADDRESSES.multiSend,
    operation: 1,
    value: "0",
    data: encodeFunctionData({
      abi: parseAbi(["function multiSend(bytes transactions)"]),
      functionName: "multiSend",
      args: [
        concat(
          entries.map((c) =>
            encodePacked(
              ["uint8", "address", "uint256", "uint256", "bytes"],
              [0, c.to, value, BigInt((c.data.length - 2) / 2), c.data],
            ),
          ),
        ),
      ],
    }),
  });
  verifyPersonalActivation(tx(), safe, registry, delegate, "25");
  assert.throws(() =>
    verifyPersonalActivation(tx(), safe, registry, delegate, "30"),
  );
  assert.throws(() =>
    verifyPersonalActivation(
      tx([...calls, { to: owner, data: "0x" as Hex }]),
      safe,
      registry,
      delegate,
      "25",
    ),
  );
  assert.throws(() =>
    verifyPersonalActivation(tx(calls, 1n), safe, registry, delegate, "25"),
  );
});
test("personal recovery never accepts an unrelated or failed transaction", async () => {
  const pending = {
    phase: "fund" as const,
    to: ADDRESSES.usdg,
    data: fundingCall(safe, "25"),
    hash: toHex(123n, { size: 32 }),
  };
  let receiptCalls = 0;
  const client: any = {
    getTransaction: async () => ({
      from: owner,
      to: ADDRESSES.usdg,
      input: pending.data,
      value: 0n,
    }),
    waitForTransactionReceipt: async () => {
      receiptCalls++;
      return { status: "success" };
    },
  };
  await assert.rejects(
    verifyPersonalTransaction(client, owner, { ...pending, hash: undefined }),
    /No transaction will be sent again/,
  );
  await assert.rejects(
    verifyPersonalTransaction(client, safe, pending),
    /does not match/,
  );
  assert.equal(receiptCalls, 0);
  await verifyPersonalTransaction(client, owner, pending);
  assert.equal(receiptCalls, 1);
  client.waitForTransactionReceipt = async () => ({ status: "reverted" });
  await assert.rejects(verifyPersonalTransaction(client, owner, pending), {
    reverted: true,
  });
});
test(
  "personal Safe and USDG funding execute against canonical contracts on a disposable local fork",
  { skip: !process.env.LOCAL_FORK_RPC, timeout: 120000 },
  async () => {
    const rpc = process.env.LOCAL_FORK_RPC!;
    assert(["127.0.0.1", "localhost"].includes(new URL(rpc).hostname));
    const account = privateKeyToAccount(`0x${"77".repeat(32)}`);
    const client = createPublicClient({ chain: RHC, transport: http(rpc) }),
      wallet = createWalletClient({
        account,
        chain: RHC,
        transport: http(rpc),
      });
    const local = (method: string, params: unknown[]) =>
      client.request({ method, params } as any);
    await local("anvil_setBalance", [account.address, toHex(10n ** 20n)]);
    const deployment = await personalDeployment(
      client as any,
      account.address,
      BigInt(Date.now()).toString(),
    );
    const hash = await wallet.sendTransaction({
      to: ADDRESSES.safeFactory,
      data: deployment.data,
    });
    await client.waitForTransactionReceipt({ hash });
    await local("evm_mine", []);
    await verifyPersonalTransaction(client as any, account.address, {
      phase: "deploy",
      to: ADDRESSES.safeFactory,
      data: deployment.data,
      hash,
    });
    await verifyPersonalSafe(client as any, deployment.safe, account.address);
    await assert.rejects(
      verifyPersonalSafe(client as any, deployment.safe, owner),
      /does not match/,
    );
    let funded = false;
    for (let slot = 0; slot < 100; slot++) {
      const location = keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "uint256" }],
          [account.address, BigInt(slot)],
        ),
      );
      const old = await client.getStorageAt({
        address: ADDRESSES.usdg,
        slot: location,
      });
      await local("anvil_setStorageAt", [
        ADDRESSES.usdg,
        location,
        toHex(100_000_000n, { size: 32 }),
      ]);
      const balance = await client.readContract({
        address: ADDRESSES.usdg,
        abi: fundingTokenAbi,
        functionName: "balanceOf",
        args: [account.address],
      });
      if (balance === 100_000_000n) {
        funded = true;
        break;
      }
      await local("anvil_setStorageAt", [
        ADDRESSES.usdg,
        location,
        old || toHex(0n, { size: 32 }),
      ]);
    }
    assert(funded);
    assert.equal(
      await client.readContract({
        address: ADDRESSES.usdg,
        abi: fundingTokenAbi,
        functionName: "decimals",
      }),
      6,
    );
    const data = fundingCall(deployment.safe, "25");
    const transfer = await wallet.sendTransaction({ to: ADDRESSES.usdg, data });
    await client.waitForTransactionReceipt({ hash: transfer });
    await local("evm_mine", []);
    await verifyPersonalTransaction(client as any, account.address, {
      phase: "fund",
      to: ADDRESSES.usdg,
      data,
      hash: transfer,
    });
    assert.equal(
      await client.readContract({
        address: ADDRESSES.usdg,
        abi: fundingTokenAbi,
        functionName: "balanceOf",
        args: [deployment.safe],
      }),
      25_000_000n,
    );
  },
);
