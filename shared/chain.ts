import { parseAbi, type Address } from "viem";
export const RHC = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: {
      name: "Robinhood Explorer",
      url: "https://explorer.mainnet.chain.robinhood.com",
    },
  },
} as const;
// Canonical deployments verified against official Safe registries and mainnet bytecode on 2026-11-03.
export const ADDRESSES = {
  safeSingleton: "0x41675C099F32341bf84BFc5382aF534df5C7461a",
  safeFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  multiSend: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
  allowanceModule: "0xAA46724893dedD72658219405185Fb0Fc91e091C",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
} satisfies Record<string, Address>;
export const ZERO = `0x${"00".repeat(32)}` as const;
export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;
export const safeAbi = parseAbi([
  "function getOwners() view returns(address[])",
  "function getThreshold() view returns(uint256)",
  "function nonce() view returns(uint256)",
  "function VERSION() view returns(string)",
  "function masterCopy() view returns(address)",
  "function isModuleEnabled(address module) view returns(bool)",
  "function enableModule(address module)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce) view returns(bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns(bool)",
  "event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash,uint256 payment)",
]);
export const allowanceAbi = parseAbi([
  "function addDelegate(address delegate)",
  "function setAllowance(address delegate,address token,uint96 allowanceAmount,uint16 resetTimeMin,uint32 resetBaseMin)",
  "function getTokenAllowance(address safe,address delegate,address token) view returns(uint256[5])",
  "function removeDelegate(address delegate,bool removeAllowances)",
]);
export const registryAbi = parseAbi([
  "function officeIdFor(address safe) view returns(bytes32)",
  "function delegateAddress(address safe,bytes32 actorId) view returns(address)",
  "function offices(bytes32 id) view returns(address safe,bytes32 seatRoot,bytes32 policyHash,uint96 cap,uint96 spent,uint32 periodStart,bool active)",
  "function delegates(bytes32 officeId,bytes32 actorId) view returns(address)",
  "function actorActive(bytes32 officeId,bytes32 actorId) view returns(bool)",
  "function budget(bytes32 officeId) view returns(uint96 cap,uint96 spent,uint32 periodStart)",
  "function operator() view returns(address)",
  "function administrator() view returns(address)",
  "function treasury() view returns(address)",
  "function token() view returns(address)",
  "function allowanceModule() view returns(address)",
  "function settlementLog() view returns(address)",
  "function open(bytes32 seatRoot,bytes32 policyHash,uint96 cap) returns(bytes32)",
  "function setSeats(bytes32 officeId,bytes32 seatRoot)",
  "function setPolicy(bytes32 officeId,bytes32 policyHash)",
  "function setCap(bytes32 officeId,uint96 cap)",
  "function setClerk(bytes32 officeId,bytes32 actorId,bool active) returns(address)",
  "function close(bytes32 officeId)",
  "function anchorReceipts(bytes32 officeId,uint64 hour,bytes32 root,uint32 count)",
  "function anchorMinutes(bytes32 officeId,bytes32 bodyHash,bytes32 signatureHash)",
]);
export const delegateAbi = parseAbi([
  "function settle(bytes32 batchId,uint64 day,uint32 expectedPeriod,bytes32 receiptRoot,uint32 receiptCount,uint96 amount)",
  "function settled(bytes32 batchId) view returns(bool)",
]);
export const tokenAbi = parseAbi([
  "function balanceOf(address account) view returns(uint256)",
  "function decimals() view returns(uint8)",
  "function symbol() view returns(string)",
]);
export type SafeTransaction = {
  to: Address;
  value: string;
  data: `0x${string}`;
  operation: 0 | 1;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: Address;
  refundReceiver: Address;
  nonce: string;
};
