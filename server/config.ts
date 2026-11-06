import { resolve } from "node:path";
import { isAddress, type Address } from "viem";
import { releasedUpdates } from "../shared/releases.ts";
export type Config = ReturnType<typeof config>;
export function config(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === "production";
  const origin = env.APP_ORIGIN || "http://localhost:5180";
  if (new URL(origin).origin !== origin)
    throw new Error(
      "APP_ORIGIN must be an origin with no path or trailing slash.",
    );
  const port = Number(env.PORT || 3080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT is invalid.");
  const databaseUrl = env.DATABASE_URL || "pglite://.local/chancery-db";
  const address = (name: string) => {
    const value = env[name];
    if (value && (!isAddress(value) || /^0x0{40}$/i.test(value)))
      throw new Error(`${name} must be an EVM address.`);
    return value as Address | undefined;
  };
  if (production && (!env.APP_ORIGIN || !origin.startsWith("https://")))
    throw new Error("Production requires HTTPS APP_ORIGIN.");
  if (production && !/^postgres(ql)?:\/\//.test(databaseUrl))
    throw new Error("Production requires PostgreSQL DATABASE_URL.");
  if (production && (!env.STORAGE_ENCRYPTION_KEY || !env.RECEIPT_SIGNING_KEY))
    throw new Error(
      "Production requires persistent storage and receipt signing keys.",
    );
  if (env.COOKIE_SAME_SITE === "none" && !production)
    throw new Error("Cross-site cookies require production HTTPS.");
  const released = releasedUpdates(env.RELEASED_UPDATES);
  const currentToken = address("CCRY_TOKEN_ADDRESS"),
    legacyToken = address("CHNC_TOKEN_ADDRESS");
  if (
    currentToken &&
    legacyToken &&
    currentToken.toLowerCase() !== legacyToken.toLowerCase()
  )
    throw new Error("Token address settings disagree.");
  const tokenAddress = currentToken || legacyToken;
  if (released.has("token_benefits") && !tokenAddress)
    throw new Error("Token benefits require CCRY_TOKEN_ADDRESS.");
  const providerFeeBps = Number(env.PROVIDER_FEE_BPS ?? 550);
  if (
    !Number.isInteger(providerFeeBps) ||
    providerFeeBps < 0 ||
    providerFeeBps > 10000
  )
    throw new Error("PROVIDER_FEE_BPS is invalid.");
  if (
    env.SETTLER_PRIVATE_KEY &&
    !/^0x[0-9a-fA-F]{64}$/.test(env.SETTLER_PRIVATE_KEY)
  )
    throw new Error("SETTLER_PRIVATE_KEY must be a 32-byte hex private key.");
  const gateway = env.PROVIDER_BASE_URL || "";
  if (env.PROVIDER_API_KEY && !gateway)
    throw new Error("PROVIDER_BASE_URL is required with PROVIDER_API_KEY.");
  if (gateway) {
    const url = new URL(gateway);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "PROVIDER_BASE_URL must be an HTTP(S) URL without credentials, query or fragment.",
      );
  }
  const reasoningMode = env.PROVIDER_REASONING_MODE || "inclusive";
  if (reasoningMode !== "inclusive" && reasoningMode !== "exclusive")
    throw new Error("Invalid PROVIDER_REASONING_MODE.");
  if (production && gateway && !gateway.startsWith("https://"))
    throw new Error("Production PROVIDER_BASE_URL must use HTTPS.");
  return {
    production,
    origin,
    databaseUrl,
    cookieSameSite:
      env.COOKIE_SAME_SITE === "none" ? ("none" as const) : ("lax" as const),
    migrationUrl: env.MIGRATION_DATABASE_URL || databaseUrl,
    port,
    host: env.HOST || (production ? "0.0.0.0" : "127.0.0.1"),
    localDir: resolve(env.LOCAL_DATA_DIR || ".local"),
    storageKey: env.STORAGE_ENCRYPTION_KEY || "",
    receiptKey: env.RECEIPT_SIGNING_KEY || "",
    rpc: env.RHC_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
    chainId: 4663,
    registry: address("CHANCERY_REGISTRY_ADDRESS"),
    tokenAddress,
    providerKey: env.PROVIDER_API_KEY || "",
    providerBaseUrl: gateway,
    reasoningMode:
      reasoningMode === "exclusive"
        ? ("exclusive" as const)
        : ("inclusive" as const),
    providerFeeBps,
    settlerKey: env.SETTLER_PRIVATE_KEY || "",
    released,
    migrateOnStart: !production && env.MIGRATE_ON_START !== "false",
    sessionSeconds: 8 * 3600,
    modelAllowlist: (env.MODEL_ALLOWLIST || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    zeroRetentionModels: (env.ZERO_RETENTION_MODELS || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  };
}
