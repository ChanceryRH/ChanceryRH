import { z } from "zod";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { uid, hash, type CryptoService } from "./crypto.ts";
import { assert } from "./errors.ts";
import { checkGuards } from "../shared/guards.ts";
import { ADDRESSES } from "../shared/chain.ts";
import type { Database } from "./db.ts";
import type { Config } from "./config.ts";
import type { Chain } from "./chain.ts";
import type { Access, Offices } from "./offices.ts";
import type { Clerks } from "./clerks.ts";
export function createUpdates(
  db: Database,
  cfg: Config,
  chain: Chain,
  crypto: CryptoService,
  offices: Offices,
  clerks: Clerks,
) {
  async function benefits(a: Access) {
    const holding = await chain.tokenBalance(a.office.safe),
      units = holding.balance / 10n ** BigInt(holding.decimals),
      tier =
        units >= 25000000n
          ? 3
          : units >= 5000000n
            ? 2
            : units >= 1000000n
              ? 1
              : 0;
    return {
      token: cfg.tokenAddress,
      safe: a.office.safe,
      balance: holding.balance.toString(),
      decimals: holding.decimals,
      tier,
      discountPercent: [0, 10, 20, 30][tier],
      discountAppliesTo: ["platform_fee", "seat_fee"],
      roadmapVote: tier === 3,
      earlyFeatures: tier >= 2,
    };
  }
  return {
    benefits,
    
    
    
    
  };
}
