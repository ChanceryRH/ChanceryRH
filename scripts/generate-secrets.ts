import { randomBytes, generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
const path = process.argv[2] || ".env.secrets";
const storage = randomBytes(32).toString("base64"),
  receipt = generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "der" })
    .toString("base64");
await writeFile(
  path,
  `STORAGE_ENCRYPTION_KEY=${storage}\nRECEIPT_SIGNING_KEY=${receipt}\n`,
  { flag: "wx", mode: 0o600 },
);
console.log(
  `Persistent encryption and receipt-signing keys saved to ${path}. Import them into Railway variables and keep a secure backup.`,
);
