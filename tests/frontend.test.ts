import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import supertest from "supertest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWeb } from "../server/web.ts";
import { ChanceryClient, ChanceryError } from "../packages/client/api.ts";
import { openDatabase } from "../server/db.ts";
import { hashTypedData } from "viem";
import { OWNER } from "./fixture.ts";
import { safeTypedTypes, encodeSafeExecution } from "../shared/safe-signing.ts";
import { ZERO_ADDRESS } from "../shared/chain.ts";
test("frontend hosting: app slash routing, deep links, assets and API boundaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chancery-web-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "app/assets"), { recursive: true });
  await mkdir(join(root, "site"), { recursive: true });
  await writeFile(
    join(root, "app/index.html"),
    "<!doctype html><title>Dashboard</title>",
  );
  await writeFile(join(root, "app/assets/app.js"), "export const app=true;");
  await writeFile(
    join(root, "site/index.html"),
    "<!doctype html><title>Landing</title>",
  );
  const app = express();
  app.use((_req, res, next) => {
    res.set("Content-Security-Policy", "default-src 'none'");
    next();
  });
  registerWeb(app, root);
  app.get("/api/config", (_req, res) => res.json({ ok: true }));
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  const client = supertest(app);
  const redirect = await client.get("/app");
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, "/app/");
  for (const route of ["/app/", "/app/workspace"]) {
    const r = await client.get(route);
    assert.equal(r.status, 200);
    assert.match(r.text, /Dashboard/);
    assert.match(r.headers["content-security-policy"], /script-src 'self'/);
    assert.doesNotMatch(
      r.headers["content-security-policy"],
      /script-src[^;]*unsafe/,
    );
  }
  assert.match((await client.get("/")).text, /Landing/);
  assert.equal((await client.get("/app/assets/app.js")).status, 200);
  assert.equal((await client.get("/app/assets/missing.js")).status, 404);
  assert.equal((await client.get("/api/missing")).status, 404);
  assert.deepEqual((await client.get("/api/config")).body, { ok: true });
  assert.equal((await client.post("/app/")).status, 404);
  assert.equal((await client.get("/.env")).status, 404);
});
test("frontend transport: refresh only rejected CSRF checks; never retry ambiguous writes", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls: any[] = [];
  let n = 0;
  globalThis.fetch = async (url: any, options: any) => {
    calls.push({ url, options });
    n++;
    if (n === 1)
      return Response.json(
        { error: { code: "csrf_invalid", message: "Refresh" } },
        { status: 403 },
      );
    if (n === 2) return Response.json({ csrfToken: "fresh-token" });
    return Response.json({ id: "same-request-id", status: "complete" });
  };
  const client = new ChanceryClient();
  client.csrfToken = "expired";
  await client.request("/offices/id/chat", { id: "same-request-id" });
  assert.deepEqual(
    calls.map((c) => c.url),
    ["/api/offices/id/chat", "/api/auth/session", "/api/offices/id/chat"],
  );
  assert.equal(calls[2].options.headers["X-CSRF-Token"], "fresh-token");
  assert.equal(calls[0].options.body, calls[2].options.body);
  assert.equal(calls[2].options.credentials, "include");
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    throw new TypeError("Network failure");
  };
  await assert.rejects(() =>
    client.request("/offices/id/chat", { id: "never-repeat" }),
  );
  assert.equal(attempts, 1);
  globalThis.fetch = async () =>
    new Response("<html>Unavailable</html>", { status: 503 });
  await assert.rejects(
    () => client.request("/config"),
    (e: any) => e instanceof ChanceryError && e.code === "response_invalid",
  );
  let expired = false;
  client.onSessionExpired = () => {
    expired = true;
  };
  globalThis.fetch = async () =>
    Response.json(
      { error: { code: "sign_in_required", message: "Sign in" } },
      { status: 401 },
    );
  await assert.rejects(() => client.session());
  assert.equal(expired, true);
  assert.equal(client.csrfToken, null);
});
test("frontend Safe signer: verifies proposal hash and wallet identity before requesting a signature", async (t) => {
  const events = new EventTarget();
  const previous = (globalThis as any).window;
  (globalThis as any).window = events;
  t.after(() => {
    (globalThis as any).window = previous;
  });
  const { signSafe, sendSafe } = await import("../web/wallet.ts");
  const tx = {
    to: OWNER.address,
    value: "0",
    data: "0x" as const,
    operation: 0 as const,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce: "0",
  };
  const typed = {
    domain: { chainId: 4663, verifyingContract: OWNER.address },
    types: safeTypedTypes,
    primaryType: "SafeTx" as const,
    message: {
      ...tx,
      value: 0n,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      nonce: 0n,
    },
  };
  const hash = hashTypedData(typed),
    methods: string[] = [];
  const provider = {
    request: async ({ method, params }: any) => {
      methods.push(method);
      if (method === "eth_accounts") return [OWNER.address];
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_signTypedData_v4") {
        const data = JSON.parse(params[1]);
        assert.equal(data.domain.chainId, 4663);
        return "0x1234";
      }
      if (method === "eth_sendTransaction") return "0x5678";
      throw Error(method);
    },
  };
  assert.equal(
    await signSafe(provider, OWNER.address, OWNER.address, tx, hash),
    "0x1234",
  );
  methods.length = 0;
  await assert.rejects(
    () =>
      signSafe(
        provider,
        OWNER.address,
        OWNER.address,
        { ...tx, value: "1" },
        hash,
      ),
    /does not match/,
  );
  assert.equal(methods.includes("eth_signTypedData_v4"), false);
  await assert.rejects(
    () => signSafe(provider, ZERO_ADDRESS, OWNER.address, tx, hash),
    /account changed/,
  );
  const signatures = [
    {
      owner: OWNER.address,
      signature: `0x${"11".repeat(65)}` as `0x${string}`,
    },
  ];
  const execution = {
    to: OWNER.address,
    data: encodeSafeExecution(tx, signatures),
    value: "0",
    chainId: 4663,
  };
  assert.equal(
    await sendSafe(
      provider,
      OWNER.address,
      OWNER.address,
      execution,
      tx,
      signatures,
    ),
    "0x5678",
  );
  methods.length = 0;
  await assert.rejects(
    () =>
      sendSafe(
        provider,
        OWNER.address,
        OWNER.address,
        { ...execution, data: "0x1234" },
        tx,
        signatures,
      ),
    /Unexpected Safe execution/,
  );
  assert.equal(methods.includes("eth_sendTransaction"), false);
});
test("local startup: a fresh embedded database creates its parent directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chancery-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = await openDatabase(`pglite://${root}/new-parent/database`);
  await database.migrate();
  assert.ok(
    (await database.query("SELECT version FROM chancery_schema")).length,
  );
  await database.close();
});
