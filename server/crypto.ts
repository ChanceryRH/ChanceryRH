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
    
    
    
    
  };
}
export type CryptoService = Awaited<ReturnType<typeof createCrypto>>;
export function envelopeLeaf(envelope: SignedEnvelope) {
  return receiptLeaf(
    Buffer.from(canonicalJson(envelope.payload)),
    Buffer.from(envelope.signature, "base64"),
  );
}
