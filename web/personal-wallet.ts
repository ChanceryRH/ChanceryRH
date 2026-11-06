import {
  concat,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  keccak256,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { ADDRESSES, RHC, ZERO_ADDRESS, safeAbi } from "../shared/chain";
import type { WalletProvider } from "./wallet";

export const personalFactoryAbi = parseAbi([
  "function proxyCreationCode() view returns(bytes)",
  "function createProxyWithNonce(address singleton,bytes initializer,uint256 saltNonce) returns(address proxy)",
]);
const setupAbi = parseAbi([
  "function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)",
]);
export const fundingTokenAbi = parseAbi([
  "function decimals() view returns(uint8)",
  "function balanceOf(address account) view returns(uint256)",
  "function transfer(address to,uint256 amount) returns(bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export const personalClient = (provider: WalletProvider) =>
  createPublicClient({ chain: RHC, transport: custom(provider) });
export type PersonalClient = ReturnType<typeof personalClient>;
export function fundingUnits(value: string) {
  if (!/^(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?$/.test(value))
    throw new Error("Enter a USDG amount with up to two decimal places.");
  const units = parseUnits(value, 6);
  if (units < 10_000n || units > 5_000_000_000n)
    throw new Error("Choose an amount from 0.01 to 5,000 USDG.");
  return units;
}
export function personalInitializer(owner: Address) {
  return encodeFunctionData({
    abi: setupAbi,
    functionName: "setup",
    args: [
      [owner],
      1n,
      ZERO_ADDRESS,
      "0x",
      ZERO_ADDRESS,
      ZERO_ADDRESS,
      0n,
      ZERO_ADDRESS,
    ],
  });
}
export async function personalDeployment(
  client: PersonalClient,
  owner: Address,
  nonce: string,
) {
  const initializer = personalInitializer(owner),
    saltNonce = BigInt(nonce);
  const code = await client.readContract({
    address: ADDRESSES.safeFactory,
    abi: personalFactoryAbi,
    functionName: "proxyCreationCode",
  });
  const bytecode = concat([
    code,
    encodeAbiParameters([{ type: "address" }], [ADDRESSES.safeSingleton]),
  ]);
  const salt = keccak256(
    concat([
      keccak256(initializer),
      encodeAbiParameters([{ type: "uint256" }], [saltNonce]),
    ]),
  );
  return {
    safe: getContractAddress({
      from: ADDRESSES.safeFactory,
      opcode: "CREATE2",
      bytecode,
      salt,
    }),
    data: encodeFunctionData({
      abi: personalFactoryAbi,
      functionName: "createProxyWithNonce",
      args: [ADDRESSES.safeSingleton, initializer, saltNonce],
    }),
  };
}
export async function verifyPersonalSafe(
  client: PersonalClient,
  safe: Address,
  owner: Address,
) {
  const [owners, threshold, version, implementation] = await Promise.all([
    client.readContract({
      address: safe,
      abi: safeAbi,
      functionName: "getOwners",
    }),
    client.readContract({
      address: safe,
      abi: safeAbi,
      functionName: "getThreshold",
    }),
    client.readContract({
      address: safe,
      abi: safeAbi,
      functionName: "VERSION",
    }),
    client.readContract({
      address: safe,
      abi: safeAbi,
      functionName: "masterCopy",
    }),
  ]);
  if (
    owners.length !== 1 ||
    owners[0].toLowerCase() !== owner.toLowerCase() ||
    threshold !== 1n ||
    version !== "1.4.1" ||
    implementation.toLowerCase() !== ADDRESSES.safeSingleton.toLowerCase()
  )
    throw new Error(
      "The personal Safe does not match your wallet. No funding was sent.",
    );
}
export type PendingPersonalTransaction = {
  phase: "deploy" | "activate" | "fund";
  to: Address;
  data: Hex;
  hash?: Hex;
};
export async function verifyPersonalTransaction(
  client: PersonalClient,
  owner: Address,
  pending: PendingPersonalTransaction,
) {
  if (!pending.hash)
    throw new Error(
      "Check the submitted transaction in your wallet and enter its hash to continue. No transaction will be sent again automatically.",
    );
  const tx = await client.getTransaction({ hash: pending.hash });
  if (
    tx.from.toLowerCase() !== owner.toLowerCase() ||
    tx.to?.toLowerCase() !== pending.to.toLowerCase() ||
    tx.input.toLowerCase() !== pending.data.toLowerCase() ||
    tx.value !== 0n
  )
    throw new Error("That transaction does not match this funding step.");
  const receipt = await client.waitForTransactionReceipt({
    hash: pending.hash,
    confirmations: 2,
    timeout: 60_000,
    pollingInterval: 1500,
  });
  if (receipt.status !== "success")
    throw Object.assign(
      new Error("The transaction reverted. You can retry this step."),
      { reverted: true },
    );
  return receipt;
}
export function fundingCall(safe: Address, amount: string) {
  return encodeFunctionData({
    abi: fundingTokenAbi,
    functionName: "transfer",
    args: [safe, fundingUnits(amount)],
  });
}
// Reject an activation payload that introduces a transfer or unrelated contract call.
export function verifyPersonalActivation(
  transaction: any,
  safe: Address,
  registry: Address,
  delegate: Address,
  amount: string,
) {
  if (
    transaction.to.toLowerCase() !== ADDRESSES.multiSend.toLowerCase() ||
    transaction.operation !== 1 ||
    BigInt(transaction.value) !== 0n
  )
    throw new Error("Unexpected personal spending approval.");
  const decoded = decodeFunctionData({
    abi: parseAbi(["function multiSend(bytes transactions)"]),
    data: transaction.data,
  });
  let bytes = (decoded.args![0] as Hex).slice(2);
  const calls: { to: string; data: Hex }[] = [];
  while (bytes.length) {
    if (
      bytes.length < 170 ||
      bytes.slice(0, 2) !== "00" ||
      BigInt("0x" + bytes.slice(42, 106)) !== 0n
    )
      throw new Error("Unexpected personal approval call.");
    const length = Number(BigInt("0x" + bytes.slice(106, 170))) * 2;
    if (!Number.isSafeInteger(length) || length > bytes.length - 170)
      throw new Error("Invalid personal approval data.");
    calls.push({
      to: "0x" + bytes.slice(2, 42),
      data: ("0x" + bytes.slice(170, 170 + length)) as Hex,
    });
    bytes = bytes.slice(170 + length);
  }
  const allowance = parseAbi([
    "function addDelegate(address delegate)",
    "function setAllowance(address delegate,address token,uint96 allowanceAmount,uint16 resetTimeMin,uint32 resetBaseMin)",
  ]);
  const expected = [
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
        args: [delegate, ADDRESSES.usdg, fundingUnits(amount), 43200, 0],
      }),
    },
  ];
  if (calls.length === 3) expected.shift();
  if (
    calls.length !== expected.length + 1 ||
    expected.some(
      (c, i) =>
        c.to.toLowerCase() !== calls[i].to.toLowerCase() ||
        c.data.toLowerCase() !== calls[i].data.toLowerCase(),
    )
  )
    throw new Error("The spending approval differs from your chosen budget.");
  const last = calls.at(-1)!;
  if (last.to.toLowerCase() !== registry.toLowerCase())
    throw new Error("Unexpected workspace registry.");
  const opened = decodeFunctionData({
    abi: parseAbi([
      "function open(bytes32 seatRoot,bytes32 policyHash,uint96 cap) returns(bytes32)",
    ]),
    data: last.data,
  });
  if (opened.args![2] !== fundingUnits(amount))
    throw new Error("The workspace budget differs from your approved amount.");
}
