import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../shared/canonical.ts";
import {
  MerkleTree,
  receiptLeaf,
} from "../shared/merkle.ts";
import type { Config } from "./config.ts";
import type { Database } from "./db.ts";
export { canonicalJson, MerkleTree, receiptLeaf };
export const uid = (prefix = "") => prefix + randomBytes(16).toString("hex");
export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export type SignedEnvelope = {
  version: 1;
  key_id: string;
  algorithm: "Ed25519";
  payload: any;
  signature: string;
};
export async function createCrypto(cfg: Config, db: Database) {
  async function localSecret(name: string, create: () => string) {
    await mkdir(cfg.localDir, { recursive: true, mode: 0o700 });
    const path = join(cfg.localDir, name);
    try {
      return await readFile(path, "utf8");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    const value = create();
    try {
      await writeFile(path, value, { flag: "wx", mode: 0o600 });
      return value;
    } catch (e: any) {
      if (e.code === "EEXIST") return readFile(path, "utf8");
      throw e;
    }
  }
  const storageKey = Buffer.from(
    cfg.storageKey ||
      (await localSecret("storage.key", () =>
        randomBytes(32).toString("base64"),
      )),
    "base64",
  );
  if (storageKey.length !== 32)
    throw Error(
      "STORAGE_ENCRYPTION_KEY must encode exactly 32 bytes in base64.",
    );
  const der =
    cfg.receiptKey ||
    (await localSecret("receipts.key", () =>
      generateKeyPairSync("ed25519")
        .privateKey.export({ format: "der", type: "pkcs8" })
        .toString("base64"),
    ));
  const privateKey = createPrivateKey({
    key: Buffer.from(der, "base64"),
    type: "pkcs8",
    format: "der",
  });
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw Error("RECEIPT_SIGNING_KEY must be Ed25519.");
  const publicKey = createPublicKey(privateKey);
  const publicDer = publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const keyId = hash(publicDer).slice(0, 24);
  await db.query(
    "INSERT INTO receipt_keys(id,public_key) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [keyId, publicDer],
  );
  return {
    keyId,
    publicKey: publicKey.export({ format: "jwk" }),
    seal(officeId: string, context: string, value: unknown) {
      const iv = randomBytes(12),
        c = createCipheriv("aes-256-gcm", storageKey, iv);
      c.setAAD(Buffer.from(`chancery:v1:${officeId}:${context}`));
      const body = Buffer.concat([
        c.update(canonicalJson(value), "utf8"),
        c.final(),
      ]);
      return [
        "v1",
        iv.toString("base64url"),
        c.getAuthTag().toString("base64url"),
        body.toString("base64url"),
      ].join(".");
    },
    open(officeId: string, context: string, value: string): any {
      const [v, iv, tag, body] = value.split(".");
      if (v !== "v1" || !iv || !tag || body === undefined)
        throw Error("Invalid encrypted record.");
      const d = createDecipheriv(
        "aes-256-gcm",
        storageKey,
        Buffer.from(iv, "base64url"),
      );
      d.setAAD(Buffer.from(`chancery:v1:${officeId}:${context}`));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return JSON.parse(
        Buffer.concat([
          d.update(Buffer.from(body, "base64url")),
          d.final(),
        ]).toString("utf8"),
      );
    },
    sign(payload: unknown): SignedEnvelope {
      return {
        version: 1,
        key_id: keyId,
        algorithm: "Ed25519",
        payload,
        signature: sign(
          null,
          Buffer.from(canonicalJson(payload)),
          privateKey,
        ).toString("base64"),
      };
    },
    async verify(envelope: SignedEnvelope) {
      if (
        envelope?.version !== 1 ||
        envelope.algorithm !== "Ed25519" ||
        typeof envelope.signature !== "string"
      )
        return false;
      const [key] = await db.query(
        "SELECT public_key FROM receipt_keys WHERE id=$1",
        [envelope.key_id],
      );
      if (!key) return false;
      try {
        return verify(
          null,
          Buffer.from(canonicalJson(envelope.payload)),
          createPublicKey({
            key: Buffer.from(key.public_key, "base64"),
            type: "spki",
            format: "der",
          }),
          Buffer.from(envelope.signature, "base64"),
        );
      } catch {
        return false;
      }
    },
  };
}
export type CryptoService = Awaited<ReturnType<typeof createCrypto>>;
export function envelopeLeaf(envelope: SignedEnvelope) {
  return receiptLeaf(
    Buffer.from(canonicalJson(envelope.payload)),
    Buffer.from(envelope.signature, "base64"),
  );
}
