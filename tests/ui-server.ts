/** Disposable browser integration fixture. Never imported by the app or shipped in the runtime image. */
import express from "express";
import { fixture, OWNER } from "./fixture.ts";
import { hash, uid } from "../server/crypto.ts";
import { readFile } from "node:fs/promises";
if (process.env.NODE_ENV === "production")
  throw new Error("The browser fixture cannot run in production.");
const runtime = await fixture(
  "rooms,clerks,safe_drafts,minutes,token_benefits",
);
runtime.cfg.origin = "http://localhost:5181";
const { account } = await runtime.login(OWNER);
const office = await runtime.office(account, "250");
await runtime.db.query("UPDATE offices SET name=$1 WHERE id=$2", [
  "Chancery QA · test Office",
  office.id,
]);
runtime.provider.catalog = async () => [
  {
    id: "test-model",
    name: "Protocol fixture · test only",
    contextLength: 100000,
    maxTokens: 8192,
    inputUsdPerMillion: "1",
    outputUsdPerMillion: "2",
    lanes: ["standard"],
  },
];
const wrapper = express();
wrapper.get("/__qa", async (_req, res) => {
  const token = uid(),
    csrf = uid();
  await runtime.db.query(
    "INSERT INTO auth_sessions(token_hash,account_id,csrf_hash,expires_at) VALUES($1,$2,$3,$4)",
    [
      hash(token),
      account.id,
      hash(csrf),
      new Date(Date.now() + 3600000).toISOString(),
    ],
  );
  res.cookie("chancery_session", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  res.redirect("/app/");
});
wrapper.get("/app/", async (_req, res) => {
  const source = await readFile("build/app/index.html", "utf8");
  res
    .type("html")
    .send(
      source.replace(
        "<body>",
        '<body><div style="position:fixed;bottom:0;right:0;z-index:1000;background:#373047;color:#ddd1fa;font:10px Arial;padding:6px 12px;border-radius:6px 0 0 0;pointer-events:none">LOCAL INTEGRATION TEST · no live AI or funds</div>',
      ),
    );
});
wrapper.use(runtime.app);
const server = wrapper.listen(5181, "127.0.0.1", () =>
  console.log(
    "Browser fixture: http://localhost:5181/__qa (disposable data only)",
  ),
);
process.on("SIGINT", () =>
  server.close(async () => {
    await runtime.db.close();
    process.exit(0);
  }),
);
