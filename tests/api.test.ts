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
test("API: CSRF, Office isolation, and disabled updates fail closed", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const owner = await r.login(),
    member = await r.login(MEMBER),
    o = await r.office(owner.account);
  assert.equal(
    (
      await owner.agent
        .post(`/api/offices/${o.id}/quotes`)
        .set("Origin", r.cfg.origin)
        .send(chat)
    ).status,
    403,
  );
  assert.equal(
    (await member.agent.get(`/api/offices/${o.id}/ledger`)).status,
    403,
  );
  for (const path of ["rooms", "clerks", "minutes", "benefits"])
    assert.equal(
      (await owner.agent.get(`/api/offices/${o.id}/${path}`)).status,
      404,
    );
  const q = await owner.agent
    .post(`/api/offices/${o.id}/quotes`)
    .set("Origin", r.cfg.origin)
    .set("X-CSRF-Token", owner.csrf)
    .send(chat);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const result = await owner.agent
    .post(`/api/offices/${o.id}/chat`)
    .set("Origin", r.cfg.origin)
    .set("X-CSRF-Token", owner.csrf)
    .send({ id: uid("req_"), quoteId: q.body.id, chat });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.chargedUsd, "0.0105");
});


