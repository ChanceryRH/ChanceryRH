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
  app.post("/api/auth/passkey/register/options", async (req, res) => {
    assert(
      passkeysAvailable({ origin: cfg.origin }),
      503,
      "passkeys_unavailable",
      "Passkeys require a domain over HTTPS or localhost.",
    );
    assert(
      !req.account,
      409,
      "already_signed_in",
      "Sign out before creating a separate passkey account.",
    );
    const accountId = uid("account_"),
      handle = newHandle();
    const options = await generateRegistrationOptions({
      rpName: "Chancery",
      rpID: new URL(cfg.origin).hostname,
      userName: "Chancery member",
      userDisplayName: "Chancery member",
      userID: Buffer.from(handle, "base64url"),
      attestationType: "none",
      supportedAlgorithmIDs: [-8, -7, -257],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });
    const challengeId = await challenge(req, res, "passkey_register", {
      challenge: options.challenge,
      accountId,
      handle,
    });
    res.json({ challengeId, options });
  });
  app.post("/api/auth/passkey/register/verify", async (req, res) => {
    const record = await consume(req, "passkey_register"),
      response = cleanResponse(req.body?.response, "create");
    assert(
      response && challengeOf(response) === record.payload.challenge,
      400,
      "passkey_invalid",
      "Passkey response is invalid.",
    );
    let result;
    try {
      result = await verifyRegistrationResponse({
        response,
        expectedChallenge: record.payload.challenge,
        expectedOrigin: cfg.origin,
        expectedRPID: new URL(cfg.origin).hostname,
        requireUserVerification: true,
      });
    } catch {
      throw new ApiError(
        401,
        "passkey_invalid",
        "Passkey could not be verified.",
      );
    }
    assert(
      result.verified && result.registrationInfo,
      401,
      "passkey_invalid",
      "Passkey could not be verified.",
    );
    const info = result.registrationInfo,
      credential = info.credential;
    const account = await db.transaction(async (q) => {
      const [a] = await q.query<Account>(
        "INSERT INTO accounts(id,credential,handle) VALUES($1,$2,$3) RETURNING *",
        [
          record.payload.accountId,
          `passkey:${hash(credential.publicKey)}`,
          record.payload.handle,
        ],
      );
      await q.query(
        "INSERT INTO passkeys(id,account_id,public_key,counter,transports,backed_up,name) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          credential.id,
          a.id,
          Buffer.from(credential.publicKey).toString("base64"),
          credential.counter,
          JSON.stringify(credential.transports || []),
          info.credentialBackedUp,
          "Passkey",
        ],
      );
      return a;
    });
    await issueSession(res, account);
  });
  app.post("/api/auth/passkey/login/options", async (req, res) => {
    assert(
      passkeysAvailable({ origin: cfg.origin }),
      503,
      "passkeys_unavailable",
      "Passkeys require a secure domain.",
    );
    const options = await generateAuthenticationOptions({
      rpID: new URL(cfg.origin).hostname,
      userVerification: "required",
    });
    const challengeId = await challenge(req, res, "passkey_login", {
      challenge: options.challenge,
    });
    res.json({ challengeId, options });
  });
  app.post("/api/auth/passkey/login/verify", async (req, res) => {
    const record = await consume(req, "passkey_login"),
      response = cleanResponse(req.body?.response, "get");
    assert(
      response && challengeOf(response) === record.payload.challenge,
      400,
      "passkey_invalid",
      "Passkey response is invalid.",
    );
    let account: Account;
    try {
      account = await db.transaction(async (q) => {
        const [key] = await q.query(
          "SELECT p.*,a.handle,a.credential,a.wallet FROM passkeys p JOIN accounts a ON a.id=p.account_id WHERE p.id=$1 FOR UPDATE OF p",
          [response.id],
        );
        assert(
          key,
          401,
          "passkey_invalid",
          "Passkey could not be verified.",
        );
        assert(
          !response.response.userHandle ||
            response.response.userHandle === key.handle,
          401,
          "passkey_invalid",
          "Passkey account did not match.",
        );
        const result = await verifyAuthenticationResponse({
          response,
          expectedChallenge: record.payload.challenge,
          expectedOrigin: cfg.origin,
          expectedRPID: new URL(cfg.origin).hostname,
          requireUserVerification: true,
          credential: {
            id: key.id,
            publicKey: Buffer.from(key.public_key, "base64"),
            counter: Number(key.counter),
            transports: key.transports,
          },
        });
        assert(
          result.verified &&
            !counterRegressed(
              Number(key.counter),
              result.authenticationInfo.newCounter,
            ),
          401,
          "passkey_invalid",
          "Passkey could not be verified.",
        );
        await q.query(
          "UPDATE passkeys SET counter=$1,failures=0,locked_until=NULL WHERE id=$2",
          [result.authenticationInfo.newCounter, key.id],
        );
        return {
          id: key.account_id,
          wallet: key.wallet,
          credential: key.credential,
          handle: key.handle,
        };
      });
    } catch {
      // A credential ID is not proof of possession. Failed assertions must not
      // change its state; the API's client-IP auth limit bounds these requests.
      throw new ApiError(
        401,
        "passkey_invalid",
        "Passkey could not be verified. Try again later.",
      );
    }
    await issueSession(res, account);
  });
  return { authenticated, csrf };
}
