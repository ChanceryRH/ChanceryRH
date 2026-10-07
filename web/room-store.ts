import { createDevice } from "../packages/client/room-crypto";
export type Device = {
  privateKey: CryptoKey;
  publicKey: JsonWebKey;
  id?: string;
};
let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("chancery-device-keys", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("vault");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () =>
      reject(
        new Error(
          "Device key storage is unavailable. Allow local storage to use encrypted Rooms.",
        ),
      );
  }));
}
export async function getStored<T>(key: string): Promise<T | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("vault", "readonly"),
      r = tx.objectStore("vault").get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function store(key: string, value: unknown) {
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction("vault", "readwrite");
    tx.objectStore("vault").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const preparing = new Map<string, Promise<Device>>();
export async function deviceFor(accountId: string, officeId: string) {
  const key = `device:${accountId}:${officeId}`;
  let pending = preparing.get(key);
  if (!pending) {
    pending = (async () => {
      const saved = await getStored<Device>(key);
      if (saved) return saved;
      const device = await createDevice();
      await store(key, device);
      return device;
    })();
    preparing.set(key, pending);
    pending.finally(() => preparing.delete(key)).catch(() => {});
  }
  return pending;
}
export async function fingerprint(key: JsonWebKey) {
  const canonical = JSON.stringify({
    crv: key.crv,
    kty: key.kty,
    x: key.x,
    y: key.y,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
