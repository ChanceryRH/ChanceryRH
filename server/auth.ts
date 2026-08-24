import type { Express, Request, Response, NextFunction } from "express";
import { getAddress, type Address, type Hex } from "viem";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  cleanResponse,
  challengeOf,
  counterRegressed,
  newHandle,
  passkeysAvailable,
} from "../shared/passkey-helpers.ts";
import { hash, uid, safeEqual } from "./crypto.ts";
import { ApiError, assert } from "./errors.ts";
import type { Database } from "./db.ts";
import type { Config } from "./config.ts";
export type Account = {
  id: string;
  wallet: Address | null;
  credential: string;
  handle: string;
  authenticated_at?: string;
  csrf_hash?: string;
};
declare global {
  namespace Express {
    interface Request {
      account?: Account;
    }
  }
}
export type WalletVerifier = (
  address: Address,
  message: string,
  signature: Hex,
) => Promise<boolean>;
const cookie = "chancery_session",
  pending = "chancery_auth";
export function registerAuth(
  app: Express,
  db: Database,
  cfg: Config,
  verifyWallet: WalletVerifier,
) {
  const cookieOptions = {
    httpOnly: true,
    secure: cfg.production,
    sameSite: cfg.cookieSameSite,
    path: "/",
  };
  async function issueSession(res: Response, account: Account) {
    const token = uid(),
      csrf = uid();
    await db.query(
      "INSERT INTO auth_sessions(token_hash,account_id,csrf_hash,expires_at) VALUES($1,$2,$3,$4)",
      [
        hash(token),
        account.id,
        hash(csrf),
        new Date(Date.now() + cfg.sessionSeconds * 1000).toISOString(),
      ],
    );
    res.cookie(cookie, token, {
      ...cookieOptions,
      maxAge: cfg.sessionSeconds * 1000,
    });
    res.json({
      account: {
        id: account.id,
        wallet: account.wallet,
        credential: account.credential,
      },
      csrfToken: csrf,
    });
  }
  app.use(async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = req.cookies?.[cookie];
      if (typeof token === "string" && token.length <= 128) {
        const [a] = await db.query<Account>(
          "SELECT a.*,s.csrf_hash,s.authenticated_at FROM auth_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now()",
          [hash(token)],
        );
        req.account = a;
      }
      next();
    } catch (e) {
      next(e);
    }
  });
  const authenticated = (req: Request, _res: Response, next: NextFunction) => {
    if (!req.account)
      return next(
        new ApiError(401, "sign_in_required", "Sign in to continue."),
      );
    next();
  };
  const csrf = (req: Request, _res: Response, next: NextFunction) => {
    const token = req.headers["x-csrf-token"];
    if (
      !req.account ||
      typeof token !== "string" ||
      !safeEqual(hash(token), req.account.csrf_hash || "")
    )
      return next(
        new ApiError(403, "csrf_invalid", "Reload your session and try again."),
      );
    next();
  };
  async function challenge(
    req: Request,
    res: Response,
    kind: string,
    payload: object,
    accountId?: string,
  ) {
    const id = uid("challenge_"),
      binding = uid();
    await db.query(
      "INSERT INTO auth_challenges(id,kind,account_id,binding_hash,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
      [
        id,
        kind,
        accountId || null,
        hash(binding),
        JSON.stringify(payload),
        new Date(Date.now() + 300000).toISOString(),
      ],
    );
    res.cookie(pending, binding, {
      ...cookieOptions,
      maxAge: 300000,
      path: "/api/auth",
    });
    return id;
  }
  async function consume(req: Request, kind: string) {
    const id = req.body?.challengeId,
      binding = req.cookies?.[pending];
    assert(
      typeof id === "string" && id.length < 100 && typeof binding === "string",
      401,
      "challenge_invalid",
      "Start sign-in again.",
    );
    const [record] = await db.query(
      "DELETE FROM auth_challenges WHERE id=$1 AND kind=$2 AND binding_hash=$3 AND expires_at>now() RETURNING *",
      [id, kind, hash(binding)],
    );
    assert(
      record,
      401,
      "challenge_invalid",
      "Sign-in expired or was already used.",
    );
    return record;
  }
  app.get("/api/auth/session", authenticated, async (req, res) => {
    const csrf = uid();
    await db.query(
      "UPDATE auth_sessions SET csrf_hash=$1 WHERE token_hash=$2",
      [hash(csrf), hash(req.cookies[cookie])],
    );
    res.json({
      account: {
        id: req.account!.id,
        wallet: req.account!.wallet,
        credential: req.account!.credential,
      },
      csrfToken: csrf,
    });
  });
  app.post("/api/auth/logout", authenticated, csrf, async (req, res) => {
    await db.query("DELETE FROM auth_sessions WHERE token_hash=$1", [
      hash(req.cookies[cookie]),
    ]);
    res.clearCookie(cookie, cookieOptions);
    res.status(204).end();
  });
  app.post("/api/auth/wallet/challenge", async (req, res) => {
    let wallet: Address;
    try {
      wallet = getAddress(req.body?.address);
    } catch {
      throw new ApiError(
        400,
        "address_invalid",
        "Enter a valid wallet address.",
      );
    }
    const nonce = uid(),
      issued = new Date(),
      expires = new Date(issued.getTime() + 300000);
    const message = `${new URL(cfg.origin).host} wants you to sign in with your Ethereum account:\n${wallet}\n\nSign in to Chancery. This signature does not authorize a payment.\n\nURI: ${cfg.origin}\nVersion: 1\nChain ID: 4663\nNonce: ${nonce}\nIssued At: ${issued.toISOString()}\nExpiration Time: ${expires.toISOString()}`;
    const challengeId = await challenge(req, res, "wallet", {
      wallet: wallet.toLowerCase(),
      message,
    });
    res.json({ challengeId, message, expiresAt: expires.toISOString() });
  });
  app.post("/api/auth/wallet/verify", async (req, res) => {
    const record = await consume(req, "wallet");
    const signature = req.body?.signature;
    assert(
      typeof signature === "string" &&
        /^0x[0-9a-f]+$/i.test(signature) &&
        signature.length <= 8194,
      400,
      "signature_invalid",
      "Invalid wallet signature.",
    );
    assert(
      await verifyWallet(
        record.payload.wallet,
        record.payload.message,
        signature as Hex,
      ),
      401,
      "signature_invalid",
      "Wallet signature could not be verified.",
    );
    const wallet = record.payload.wallet;
    const [account] = await db.query<Account>(
      "INSERT INTO accounts(id,wallet,credential,handle) VALUES($1,$2,$3,$4) ON CONFLICT(wallet) DO UPDATE SET wallet=excluded.wallet RETURNING *",
      [uid("account_"), wallet, `wallet:${wallet}`, newHandle()],
    );
    await issueSession(res, account);
  });
  
  
  
  
  return { authenticated, csrf };
}
