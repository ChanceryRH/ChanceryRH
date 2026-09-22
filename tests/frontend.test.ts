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



