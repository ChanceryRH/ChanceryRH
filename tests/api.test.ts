import { test } from "node:test";
import assert from "node:assert/strict";
import supertest from "supertest";
import { fixture, OWNER, MEMBER, chat } from "./fixture.ts";
import { uid } from "../server/crypto.ts";
test("API: wallet challenge is bound, one-use and origin protected", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const agent = supertest.agent(r.app);
  assert.equal(
    (
      await agent
        .post("/api/auth/wallet/challenge")
        .send({ address: OWNER.address })
    ).status,
    403,
  );
  assert.equal(
    (
      await agent
        .post("/api/auth/wallet/challenge")
        .set("Origin", "https://evil.example")
        .send({ address: OWNER.address })
    ).status,
    403,
  );
  const c = await agent
    .post("/api/auth/wallet/challenge")
    .set("Origin", r.cfg.origin)
    .send({ address: OWNER.address });
  const payload = {
    challengeId: c.body.challengeId,
    signature: await OWNER.signMessage({ message: c.body.message }),
  };
  assert.equal(
    (
      await supertest(r.app)
        .post("/api/auth/wallet/verify")
        .set("Origin", r.cfg.origin)
        .send(payload)
    ).status,
    401,
  );
  assert.equal(
    (
      await agent
        .post("/api/auth/wallet/verify")
        .set("Origin", r.cfg.origin)
        .send(payload)
    ).status,
    200,
  );
  assert.equal(
    (
      await agent
        .post("/api/auth/wallet/verify")
        .set("Origin", r.cfg.origin)
        .send(payload)
    ).status,
    401,
  );
});



