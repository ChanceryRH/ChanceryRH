/** One EIP-712 schema for browser signing and server verification. */
import { concat, encodeFunctionData, type Hex } from "viem";
import { safeAbi, type SafeTransaction } from "./chain.ts";
export const safeTypedTypes = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export function encodeSafeExecution(
  tx: SafeTransaction,
  signatures: { owner: string; signature: Hex }[],
) {
  const ordered = [...signatures].sort((a, b) =>
    a.owner.toLowerCase().localeCompare(b.owner.toLowerCase()),
  );
  return encodeFunctionData({
    abi: safeAbi,
    functionName: "execTransaction",
    args: [
      tx.to,
      BigInt(tx.value),
      tx.data,
      tx.operation,
      BigInt(tx.safeTxGas),
      BigInt(tx.baseGas),
      BigInt(tx.gasPrice),
      tx.gasToken,
      tx.refundReceiver,
      concat(ordered.map((s) => s.signature)),
    ],
  });
}
