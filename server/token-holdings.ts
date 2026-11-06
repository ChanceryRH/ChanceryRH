import { parseAbi, type Address } from "viem";
import { tokenAbi } from "../shared/chain.ts";
const transfer = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
])[0];
/** Continuous minimum across every observed transfer, including same-block out-and-back movements. */
export function minimumHolding(
  initial: bigint,
  current: bigint,
  safe: Address,
  logs: any[],
) {
  let balance = initial,
    minimum = initial;
  const address = safe.toLowerCase(),
    seen = new Set<string>();
  for (const log of [...logs].sort(
    (a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex,
  )) {
    if (log.removed || log.logIndex == null || !log.transactionHash)
      throw Error("Incomplete transfer history");
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { from, to, value } = log.args || {};
    if (!from || !to || typeof value !== "bigint" || value < 0n)
      throw Error("Invalid transfer history");
    if (from.toLowerCase() === address) balance -= value;
    if (to.toLowerCase() === address) balance += value;
    if (balance < 0n) throw Error("Inconsistent transfer history");
    if (balance < minimum) minimum = balance;
  }
  if (balance !== current) throw Error("Incomplete transfer history");
  return minimum;
}
export async function tokenHoldingWindow(
  client: any,
  token: Address,
  safe: Address,
) {
  const end = await client.getBlock({ blockTag: "latest" });
  if (end.number === null || end.timestamp < 86400n)
    throw Error("Holding history unavailable");
  const cutoff = end.timestamp - 86400n;
  let low = 0n,
    high = end.number;
  while (low < high) {
    const mid = (low + high + 1n) / 2n,
      block = await client.getBlock({ blockNumber: mid });
    if (block.timestamp <= cutoff) low = mid;
    else high = mid - 1n;
  }
  const start = low;
  const [initial, current, decimals] = await Promise.all([
    client.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [safe],
      blockNumber: start,
    }),
    client.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [safe],
      blockNumber: end.number,
    }),
    client.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "decimals",
      blockNumber: end.number,
    }),
  ]);
  if (decimals > 36) throw Error("Unsupported token decimals");
  let queries = 0;
  async function logs(
    args: any,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<any[]> {
    if (fromBlock > toBlock) return [];
    if (++queries > 256) throw Error("Holding history exceeds lookup budget");
    try {
      return await client.getLogs({
        address: token,
        event: transfer,
        args,
        fromBlock,
        toBlock,
        strict: true,
      });
    } catch (error) {
      if (
        toBlock === fromBlock ||
        !/range|limit|too many|response size/i.test(String(error))
      )
        throw error;
      const mid = (fromBlock + toBlock) / 2n;
      return [
        ...(await logs(args, fromBlock, mid)),
        ...(await logs(args, mid + 1n, toBlock)),
      ];
    }
  }
  const outgoing = await logs({ from: safe }, start + 1n, end.number),
    incoming = await logs({ to: safe }, start + 1n, end.number);
  // Recheck the anchor: results from different forks cannot qualify a discount.
  if ((await client.getBlock({ blockNumber: end.number })).hash !== end.hash)
    throw Error("Holding history changed");
  return {
    balance: current as bigint,
    eligibleBalance: minimumHolding(initial, current, safe, [
      ...outgoing,
      ...incoming,
    ]),
    decimals: Number(decimals),
    windowHours: 24,
    block: end.number.toString(),
  };
}
