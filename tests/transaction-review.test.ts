import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { reviewTransaction } from "../shared/transaction-review.ts";
import { ADDRESSES, ZERO } from "../shared/chain.ts";
const recipient = "0x0000000000000000000000000000000000000008";
test("Transaction review: transfer, transferFrom, allowance and permit carry decoded financial facts", () => {
  const cases = [
    [
      "function transfer(address to,uint256 amount)",
      [recipient, 1250000n],
      "Recipient",
    ],
    [
      "function transferFrom(address from,address to,uint256 amount)",
      [recipient, recipient, 1250000n],
      "Amount / token ID",
    ],
    [
      "function increaseAllowance(address spender,uint256 value)",
      [recipient, 1250000n],
      "Allowance increase",
    ],
    [
      "function approve(address spender,uint256 value)",
      [recipient, (1n << 256n) - 1n],
      "Allowance",
    ],
    [
      "function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
      [recipient, recipient, 1250000n, 123n, 27, ZERO, ZERO],
      "Deadline (Unix seconds)",
    ],
  ] as const;
  for (const [signature, args, label] of cases) {
    const abi = parseAbi([signature]);
    const data = encodeFunctionData({
      abi,
      functionName: signature.split(" ")[1].split("(")[0],
      args,
    } as any);
    const r = reviewTransaction({ to: ADDRESSES.usdg, data, value: "0" });
    assert(r.recognized);
    assert(r.facts.some((f) => f.label === label));
    assert(r.risks.length >= 2);
  }
  const unknown = reviewTransaction({
    to: recipient,
    data: "0x12345678",
    value: "1000000000000000000",
  });
  assert(!unknown.recognized);
  assert(unknown.facts.some((f) => f.value === "1 ETH"));
  assert(unknown.risks.some((s) => s.includes("Unknown")));
  assert.throws(() =>
    reviewTransaction({ to: recipient, data: "0xa9059cbb", value: "0" }),
  );
});
