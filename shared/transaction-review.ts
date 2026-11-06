import {
  decodeFunctionData,
  formatEther,
  formatUnits,
  parseAbi,
  type Hex,
} from "viem";
import { ADDRESSES } from "./chain.ts";
const abi = parseAbi([
  "function transfer(address to,uint256 amount) returns(bool)",
  "function transferFrom(address from,address to,uint256 amount) returns(bool)",
  "function approve(address spender,uint256 amount) returns(bool)",
  "function increaseAllowance(address spender,uint256 addedValue) returns(bool)",
  "function decreaseAllowance(address spender,uint256 subtractedValue) returns(bool)",
  "function setApprovalForAll(address operator,bool approved)",
  "function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
  "function permit(address holder,address spender,uint256 nonce,uint256 expiry,bool allowed,uint8 v,bytes32 r,bytes32 s)",
]);
const recognized = new Set([
  "0xa9059cbb",
  "0x23b872dd",
  "0x095ea7b3",
  "0x39509351",
  "0xa457c2d7",
  "0xa22cb465",
  "0xd505accf",
  "0x8fcbaf0c",
]);
export function reviewTransaction(call: {
  to: string;
  data: Hex;
  value: string;
}) {
  const risks: string[] = [],
    facts: { label: string; value: string }[] = [
      { label: "Contract / recipient", value: call.to },
    ];
  const value = BigInt(call.value);
  if (value > 0n) {
    risks.push("Transfers native ETH");
    facts.push({ label: "Native amount", value: formatEther(value) + " ETH" });
  }
  if (call.data === "0x")
    return { recognized: true, method: "Native transfer", risks, facts };
  const selector = call.data.slice(0, 10).toLowerCase();
  if (!recognized.has(selector))
    return {
      recognized: false,
      method: "Unrecognized contract call",
      risks: [
        ...risks,
        "Unknown calldata: inspect the full call before signing",
      ],
      facts,
    };
  // Known selectors with malformed arguments must not be downgraded to a generic warning.
  const decoded = decodeFunctionData({ abi, data: call.data }),
    args = decoded.args as readonly any[];
  const tokenAmount = (amount: bigint) =>
    call.to.toLowerCase() === ADDRESSES.usdg.toLowerCase()
      ? formatUnits(amount, 6) + " USDG"
      : amount.toString() + " raw units (verify the asset and decimals)";
  const permission = (spender: string, amount: bigint, label = "Allowance") => {
    facts.push(
      { label: "Spender", value: spender },
      {
        label,
        value:
          amount === (1n << 256n) - 1n
            ? "Unlimited (maximum uint256)"
            : tokenAmount(amount),
      },
    );
    risks.push("Changes token spending permission");
  };
  switch (decoded.functionName) {
    case "transfer":
      risks.push("Transfers tokens");
      facts.push(
        { label: "Recipient", value: args[0] },
        { label: "Amount", value: tokenAmount(args[1]) },
      );
      break;
    case "transferFrom":
      risks.push("Moves tokens from an authorized account");
      facts.push(
        { label: "From", value: args[0] },
        { label: "Recipient", value: args[1] },
        { label: "Amount / token ID", value: tokenAmount(args[2]) },
      );
      break;
    case "approve":
      permission(args[0], args[1]);
      break;
    case "increaseAllowance":
      permission(args[0], args[1], "Allowance increase");
      break;
    case "decreaseAllowance":
      permission(args[0], args[1], "Allowance decrease");
      break;
    case "setApprovalForAll":
      risks.push(
        args[1]
          ? "Grants operator access to all tokens"
          : "Revokes operator access to all tokens",
      );
      facts.push(
        { label: "Operator", value: args[0] },
        { label: "Access", value: args[1] ? "All tokens" : "Revoked" },
      );
      break;
    case "permit":
      risks.push("Uses a signed token permission");
      facts.push({ label: "Permission owner", value: args[0] });
      if (args.length === 7) {
        permission(args[1], args[2]);
        facts.push({
          label: "Deadline (Unix seconds)",
          value: String(args[3]),
        });
      } else {
        facts.push(
          { label: "Spender", value: args[1] },
          { label: "Allowed", value: String(args[4]) },
          { label: "Expiry (Unix seconds)", value: String(args[3]) },
        );
      }
  }
  risks.push(
    "Selector decoding does not verify what arbitrary contract code will do",
  );
  return { recognized: true, method: decoded.functionName, risks, facts };
}
