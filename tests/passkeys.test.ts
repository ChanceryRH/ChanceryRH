import { test } from "node:test";
import assert from "node:assert/strict";
import {
  randomBytes,
  generateKeyPairSync,
  createHash,
  sign,
} from "node:crypto";
import { encodeCBOR } from "@levischuck/tiny-cbor";
import supertest from "supertest";
import { fixture } from "./fixture.ts";
const sha = (input: Buffer | string) =>
  createHash("sha256").update(input).digest();
test("Passkeys: complete registration and authentication verify origin, user verification and counter", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  const agent = supertest.agent(r.app),
    pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
    jwk = pair.publicKey.export({ format: "jwk" }),
    credential = randomBytes(32),
    id = credential.toString("base64url");
  const options = await agent
    .post("/api/auth/passkey/register/options")
    .set("Origin", r.cfg.origin)
    .send({});
  assert.equal(options.status, 200, JSON.stringify(options.body));
  const client = Buffer.from(
    JSON.stringify({
      type: "webauthn.create",
      challenge: options.body.options.challenge,
      origin: r.cfg.origin,
      crossOrigin: false,
    }),
  );
  const cose = encodeCBOR(
    new Map<number, any>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]),
  );
  const length = Buffer.alloc(2);
  length.writeUInt16BE(credential.length);
  const authData = Buffer.concat([
    sha("localhost"),
    Buffer.from([0x45]),
    Buffer.alloc(4),
    Buffer.alloc(16),
    length,
    credential,
    Buffer.from(cose),
  ]);
  const attestation = Buffer.from(
    encodeCBOR(
      new Map<string, any>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    ),
  );
  const response = {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: client.toString("base64url"),
      attestationObject: attestation.toString("base64url"),
      transports: ["internal"],
    },
  };
  const registered = await agent
    .post("/api/auth/passkey/register/verify")
    .set("Origin", r.cfg.origin)
    .send({ challengeId: options.body.challengeId, response });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  await agent
    .post("/api/auth/logout")
    .set("Origin", r.cfg.origin)
    .set("X-CSRF-Token", registered.body.csrfToken)
    .send({});
  async function assertion(counter: number, origin = r.cfg.origin, flags = 5, signer = pair.privateKey, clientAgent = agent) {
    const o = await clientAgent
        .post("/api/auth/passkey/login/options")
        .set("Origin", r.cfg.origin)
        .send({}),
      c = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: o.body.options.challenge,
          origin,
          crossOrigin: false,
        }),
      ),
      count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    const data = Buffer.concat([sha("localhost"), Buffer.from([flags]), count]),
      signature = sign(
        "sha256",
        Buffer.concat([data, sha(c)]),
        signer,
      );
    return clientAgent
      .post("/api/auth/passkey/login/verify")
      .set("Origin", r.cfg.origin)
      .send({
        challengeId: o.body.challengeId,
        response: {
          id,
          rawId: id,
          type: "public-key",
          clientExtensionResults: {},
          response: {
            authenticatorData: data.toString("base64url"),
            clientDataJSON: c.toString("base64url"),
            signature: signature.toString("base64url"),
          },
        },
      });
  }
  assert.equal((await assertion(1)).status, 200);
  assert.equal((await assertion(1)).status, 401);
  assert.equal((await assertion(2, "https://evil.example")).status, 401);
  assert.equal((await assertion(2, r.cfg.origin, 1)).status, 401);
  const attacker = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const attackerAgent = supertest.agent(r.app);
  const before = await r.db.query("SELECT counter,failures,locked_until FROM passkeys WHERE id=$1", [id]);
  for (let i = 0; i < 5; i++)
    assert.equal((await assertion(2, r.cfg.origin, 5, attacker.privateKey, attackerAgent)).status, 401);
  assert.deepEqual(await r.db.query("SELECT counter,failures,locked_until FROM passkeys WHERE id=$1", [id]), before);
  assert.equal((await assertion(2)).status, 200, "invalid assertions cannot lock the genuine credential");
  // Credentials locked by an older server version also recover without waiting.
  await r.db.query("UPDATE passkeys SET failures=99,locked_until=now()+interval '15 minutes' WHERE id=$1", [id]);
  assert.equal((await assertion(3)).status, 200);
  const [recovered] = await r.db.query("SELECT failures,locked_until FROM passkeys WHERE id=$1", [id]);
  assert.equal(recovered.failures, 0);
  assert.equal(recovered.locked_until, null);
});

test("Passkeys: authentication throttling rejects excess client requests before issuing challenges", async (t) => {
  const r = await fixture();
  t.after(() => r.db.close());
  // Simulate the deployment's trusted single proxy; forwarding headers are only
  // trusted because this test explicitly configures that proxy boundary.
  r.app.set("trust proxy", 1);
  const attacker = supertest(r.app);
  for (let i = 0; i < 40; i++) {
    const result = await attacker.post("/api/auth/passkey/login/options")
      .set("Origin", r.cfg.origin).set("X-Forwarded-For", "192.0.2.10").send({});
    assert.equal(result.status, 200);
  }
  const denied = await attacker.post("/api/auth/passkey/login/options")
    .set("Origin", r.cfg.origin).set("X-Forwarded-For", "192.0.2.10").send({});
  assert.equal(denied.status, 429);
  assert.equal(denied.headers["retry-after"], "60");
  const other = await supertest(r.app).post("/api/auth/passkey/login/options")
    .set("Origin", r.cfg.origin).set("X-Forwarded-For", "192.0.2.20").send({});
  assert.equal(other.status, 200);
});
