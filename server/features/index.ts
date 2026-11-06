import type { Express, Request, Response } from "express";
import type { UpdateId } from "../../shared/releases.ts";
import type { Database } from "../db.ts";
import type { Config } from "../config.ts";
import type { Chain } from "../chain.ts";
import type { CryptoService } from "../crypto.ts";
import type { Provider } from "../provider.ts";
import type { Access, Offices } from "../offices.ts";
import type { Ledger } from "../ledger.ts";
import type { Clerks } from "../clerks.ts";
import type { createConversations } from "../conversations.ts";
import { register as playbooks } from "./playbooks.ts";
import { register as sideBySide } from "./side-by-side.ts";
import { register as guestPasses } from "./guest-passes.ts";
import { register as reimbursements } from "./reimbursements.ts";
import { register as officeFiles } from "./office-files.ts";
export type FeatureHandler = (
  a: Access,
  req: Request,
  res: Response,
) => Promise<any>;
export type FeatureContext = {
  app: Express;
  /** Office-scoped route under /api/offices/:officeId. Pass the update ID so the route stays hidden until released. */
  route: (
    method: "get" | "post" | "delete",
    path: string,
    fn: FeatureHandler,
    gate?: UpdateId,
    allowPending?: boolean,
  ) => void;
  param: (req: Request, name: string) => string;
  db: Database;
  cfg: Config;
  chain: Chain;
  crypto: CryptoService;
  provider: Provider;
  offices: Offices;
  ledger: Ledger;
  clerks: Clerks;
  conversations: ReturnType<typeof createConversations>;
};
// Each update owns one module. Its routes must pass its update ID as the gate.
export function registerFeatures(ctx: FeatureContext) {
  playbooks(ctx);
  sideBySide(ctx);
  guestPasses(ctx);
  reimbursements(ctx);
  officeFiles(ctx);
}
