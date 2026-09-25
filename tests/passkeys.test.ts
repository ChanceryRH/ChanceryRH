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
  async function assertion(counter: number, origin = r.cfg.origin, flags = 5) {
    const o = await agent
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
        pair.privateKey,
      );
    return agent
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
            userHandle: options.body.options.user.id,
          },
        },
      });
  }
  assert.equal((await assertion(1)).status, 200);
  assert.equal((await assertion(1)).status, 401);
  assert.equal((await assertion(2, "https://evil.example")).status, 401);
  assert.equal((await assertion(2, r.cfg.origin, 1)).status, 401);
});
