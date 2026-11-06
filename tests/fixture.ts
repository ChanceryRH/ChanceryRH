import { generateKeyPairSync, randomBytes } from "node:crypto";
import postgres from "postgres";
import supertest from "supertest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage, keccak256, toBytes, type Hex } from "viem";
import { config } from "../server/config.ts";
import { openDatabase } from "../server/db.ts";
import { createApp } from "../server/app.ts";
import {
  officeIdFor,
  seatLeaf,
  type Chain,
  type OfficeSnapshot,
} from "../server/chain.ts";
import { policySchema, policyHash } from "../server/offices.ts";
import { uid, MerkleTree } from "../server/crypto.ts";
import { dollars } from "../shared/money.ts";
import { ZERO, ZERO_ADDRESS } from "../shared/chain.ts";
import type { Provider } from "../server/provider.ts";
export const OWNER = privateKeyToAccount(`0x${"11".repeat(32)}`),
  MEMBER = privateKeyToAccount(`0x${"22".repeat(32)}`);
export async function fixture(released = "", databaseUrl = "pglite://memory") {
  let cleanupDatabase: (() => Promise<void>) | undefined;
  if (process.env.FULL_POSTGRES_URL && databaseUrl === "pglite://memory") {
    const admin = postgres(process.env.FULL_POSTGRES_URL, {
        max: 1,
        onnotice: () => {},
      }),
      name = uid("chancery_test_");
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.FULL_POSTGRES_URL);
    url.pathname = `/${name}`;
    databaseUrl = url.toString();
    cleanupDatabase = async () => {
      try {
        await admin.unsafe(`DROP DATABASE ${name}`);
      } finally {
        await admin.end({ timeout: 5 });
      }
    };
  }
  const cfg = config({
    DATABASE_URL: databaseUrl,
    APP_ORIGIN: "http://localhost:5180",
    PROVIDER_API_KEY: "test-only",
    PROVIDER_BASE_URL: "https://gateway.example.invalid",
    CHANCERY_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000000099",
    CHNC_TOKEN_ADDRESS: "0x0000000000000000000000000000000000000088",
    RELEASED_UPDATES: released,
    STORAGE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    RECEIPT_SIGNING_KEY: generateKeyPairSync("ed25519")
      .privateKey.export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  });
  const db = await openDatabase(cfg.databaseUrl),
    close = db.close.bind(db);
  db.close = async () => {
    await close();
    await cleanupDatabase?.();
  };
  await db.migrate();
  cfg.migrateOnStart = false;
  const snapshots = new Map<string, OfficeSnapshot>();
  const chain = {
    snapshot: async (id: string, actor = ZERO) => {
      const s = snapshots.get(id);
      if (!s) throw Error("Office missing");
      return { ...s };
    },
    safe: async (address: any) => ({
      address,
      owners: [OWNER.address.toLowerCase()],
      threshold: 1,
      nonce: "0",
      block: "100",
      moduleEnabled: true,
    }),
    verifyWallet: async (address: any, message: string, signature: Hex) =>
      verifyMessage({ address, message, signature }),
    configuration: async () => ({
      chainId: 4663,
      registry: cfg.registry,
      operator: OWNER.address,
      treasury: MEMBER.address,
      administrator: OWNER.address,
      settlementLog: cfg.registry,
    }),
    delegateFor: async () => "0x0000000000000000000000000000000000000055",
    prepare: async (address: any, calls: any[]) => ({
      safe: {
        address,
        owners: [OWNER.address.toLowerCase()],
        threshold: 1,
        nonce: "0",
      },
      transaction: {
        to: address,
        value: "0",
        data: "0x",
        operation: 0,
        safeTxGas: "0",
        baseGas: "0",
        gasPrice: "0",
        gasToken: ZERO_ADDRESS,
        refundReceiver: ZERO_ADDRESS,
        nonce: "0",
      },
      safeTxHash: keccak256(toBytes(JSON.stringify({ address, calls }))),
      typedData: {},
    }),
    findSafeExecution: async () => null,
    tokenHoldingWindow: async () => ({
      balance: 25000000n * 10n ** 18n,
      eligibleBalance: 25000000n * 10n ** 18n,
      decimals: 18,
      windowHours: 24,
      block: "100",
    }),
    tokenBalance: async () => ({
      balance: 25000000n * 10n ** 18n,
      decimals: 18,
    }),
    client: { getBlockNumber: async () => 100n },
  } as unknown as Chain;
  let calls = 0;
  let cost: bigint | null = dollars("0.01"),
    fail: any = null;
  const provider: Provider = {
    models: async () => [],
    catalog: async () => [],
    estimate: async () => ({
      providerMaximum: dollars("0.1"),
      inputTokensEstimate: 20,
      model: {},
    }),
    complete: async () => {
      calls++;
      if (fail) throw fail;
      return {
        content: "Working answer",
        reasoning: "",
        id: "provider_test",
        rawUsage: { prompt_tokens: 12, completion_tokens: 5 },
        usage: { prompt_tokens: 12, completion_tokens: 5 },
        cost,
        costBasis: cost === null ? "unknown" : "reported",
      };
    },
  };
  const runtime = await createApp({ cfg, db, chain, provider });
  async function login(wallet = OWNER) {
    const agent = supertest.agent(runtime.app),
      challenge = await agent
        .post("/api/auth/wallet/challenge")
        .set("Origin", cfg.origin)
        .send({ address: wallet.address });
    if (challenge.status !== 200) throw Error(JSON.stringify(challenge.body));
    const signature = await wallet.signMessage({
        message: challenge.body.message,
      }),
      response = await agent
        .post("/api/auth/wallet/verify")
        .set("Origin", cfg.origin)
        .send({ challengeId: challenge.body.challengeId, signature });
    if (response.status !== 200) throw Error(JSON.stringify(response.body));
    const [account] = await db.query("SELECT * FROM accounts WHERE id=$1", [
      response.body.account.id,
    ]);
    return { agent, account, csrf: response.body.csrfToken };
  }
  async function office(account: any, cap = "100", suffix = 1) {
    const safe = `0x${suffix.toString(16).padStart(40, "0")}` as Hex,
      id = officeIdFor(safe),
      policy = policySchema.parse({ maxRequestUsd: "2" }),
      sid = uid("seat_"),
      leaf = seatLeaf(
        account.credential,
        "principal",
        dollars(cap).toString(),
        null,
      ),
      root = new MerkleTree([leaf]).root;
    await db.query(
      "INSERT INTO offices(id,safe,name,registry,delegate,seat_root,policy_hash,policy,cap_pico,owners,status) VALUES($1,$2,'Test',$3,$4,$5,$6,$7,$8,$9,'active')",
      [
        id,
        safe,
        cfg.registry,
        "0x0000000000000000000000000000000000000055",
        root,
        policyHash(policy),
        JSON.stringify(policy),
        dollars(cap).toString(),
        JSON.stringify([OWNER.address.toLowerCase()]),
      ],
    );
    await db.office(id, async (q) => {
      await q.query("INSERT INTO office_locks(office_id) VALUES($1)", [id]);
      await q.query(
        "INSERT INTO seats(id,office_id,account_id,credential,role,monthly_cap_pico,status,leaf,approved_root) VALUES($1,$2,$3,$4,'principal',$5,'active',$6,$7)",
        [
          sid,
          id,
          account.id,
          account.credential,
          dollars(cap).toString(),
          leaf,
          root,
        ],
      );
    });
    // Simulate a seat fee already collected before this budget period, so usage tests isolate inference accounting.
    await db.office(id, (q) =>
      q.query(
        "INSERT INTO seat_charges(office_id,seat_id,day,receipt_id) VALUES($1,$2,$3,$4)",
        [id, sid, Math.floor(Date.now() / 86400000), "fixture_prepaid"],
      ),
    );
    const s: OfficeSnapshot = {
      id,
      safe,
      seatRoot: root,
      policyHash: policyHash(policy),
      capUnits: BigInt(Math.floor(Number(cap) * 1e6)),
      spentUnits: 0n,
      periodStart: Math.floor(Date.now() / 60000),
      active: true,
      delegate: "0x0000000000000000000000000000000000000055",
      actorActive: true,
      allowanceUnits: BigInt(Math.floor(Number(cap) * 1e6)),
      allowanceSpentUnits: 0n,
      allowancePeriod: Math.floor(Date.now() / 60000),
      allowanceInterval: 43200,
      safeBalanceUnits: 1000000000n,
      owners: [OWNER.address.toLowerCase() as Hex],
      threshold: 1,
      moduleEnabled: true,
      block: "100",
    };
    snapshots.set(id, s);
    return {
      id,
      snapshot: s,
      access: await runtime.offices.access(account, id),
    };
  }
  return {
    ...runtime,
    login,
    office,
    snapshots,
    calls: () => calls,
    setCost: (value: bigint | null) => {
      cost = value;
    },
    fail: (error: any) => {
      fail = error;
    },
  };
}
export const chat = {
  model: "test-model",
  messages: [{ role: "user" as const, content: "Summarize our office tasks." }],
  maxTokens: 100,
  lane: "standard" as const,
};
