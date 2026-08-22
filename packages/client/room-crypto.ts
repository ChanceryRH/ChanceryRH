/** Browser Web Crypto helpers. Keys stay on the device; the API receives wrapped keys and ciphertext.
 * AES-GCM binds Room items to their Office, Room, epoch and item identifiers.
 * Pin the device directory in the client: a server that replaces recipient public keys can add recipients.
 */
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64 = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
const context = (
  officeId: string,
  roomId: string,
  epoch: number,
  tail: string,
) => encoder.encode(`chancery:room:v1:${officeId}:${roomId}:${epoch}:${tail}`);
export type WrappedKey = {
  ephemeralPublicKey: JsonWebKey;
  nonce: string;
  ciphertext: string;
};
export async function createDevice() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  return {
    privateKey: pair.privateKey,
    publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
  };
}
export async function createRoomKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}
async function wrappingKey(
  privateKey: CryptoKey,
  publicKey: JsonWebKey,
  info: Uint8Array,
) {
  const peer = await crypto.subtle.importKey(
    "jwk",
    publicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const secret = await crypto.subtle.deriveBits(
      { name: "ECDH", public: peer },
      privateKey,
      256,
    ),
    material = await crypto.subtle.importKey("raw", secret, "HKDF", false, [
      "deriveKey",
    ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: info as BufferSource,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function wrapRoomKey(
  roomKey: Uint8Array,
  recipient: JsonWebKey,
  officeId: string,
  roomId: string,
  epoch: number,
  deviceId: string,
): Promise<WrappedKey> {
  if (roomKey.length !== 32) throw Error("Room key must be 32 bytes.");
  const ephemeral = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ),
    aad = context(officeId, roomId, epoch, `device:${deviceId}`),
    key = await wrappingKey(ephemeral.privateKey, recipient, aad),
    nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad },
    key,
    roomKey as BufferSource,
  );
  return {
    ephemeralPublicKey: await crypto.subtle.exportKey(
      "jwk",
      ephemeral.publicKey,
    ),
    nonce: b64(nonce),
    ciphertext: b64(new Uint8Array(ciphertext)),
  };
}



