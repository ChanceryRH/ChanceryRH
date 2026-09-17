import { config } from "./config.ts";
import { openDatabase } from "./db.ts";
const cfg = config(),
  db = await openDatabase(cfg.migrationUrl);
try {
  await db.migrate();
  console.log("Chancery database migrations applied.");
} finally {
  await db.close();
}
