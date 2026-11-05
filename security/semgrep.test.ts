// Scanner fixtures only; never imported or executed by the application.
import { exec as shellCommand, spawn } from "node:child_process";
import { execSync } from "child_process";
async function databaseFixture(exec: (sql: string) => Promise<void>) {
  // ok: chancery-no-shell-command
  await exec("CREATE TABLE example (id integer)");
}
function examples(req: any, db: any) {
  // ruleid: chancery-no-dynamic-code
  eval(req.body.code);
  // ok: chancery-no-dynamic-code
  JSON.parse(req.body.json);
  // ruleid: chancery-no-shell-command
  shellCommand(req.body.command);
  // ruleid: chancery-no-shell-command
  execSync(req.body.command);
  // ruleid: chancery-no-shell-command
  spawn("git", ["status"], {shell: true});
  // ok: chancery-no-shell-command
  spawn("git", ["status"], {shell: false});
  // ruleid: chancery-verify-tls
  const insecure = {rejectUnauthorized: false};
  // ok: chancery-verify-tls
  const secure = {rejectUnauthorized: true};
  // ruleid: chancery-modern-crypto
  createHash("md5");
  // ok: chancery-modern-crypto
  createHash("sha256");
  // ruleid: chancery-parameterized-sql
  db.query("SELECT * FROM seats WHERE id=" + req.params.id);
  // ok: chancery-parameterized-sql
  db.query("SELECT * FROM seats WHERE id=$1", [req.params.id]);
  // ruleid: chancery-no-request-fetch
  fetch(req.body.url);
  // ok: chancery-no-request-fetch
  fetch(configuredProviderUrl, {method: "POST", body: JSON.stringify(req.body)});
}
