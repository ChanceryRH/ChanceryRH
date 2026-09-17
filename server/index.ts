import { createApp } from "./app.ts";
const runtime = await createApp();
const server = runtime.app.listen(runtime.cfg.port, runtime.cfg.host, () =>
  console.log(
    JSON.stringify({
      event: "listening",
      port: runtime.cfg.port,
      service: "chancery-backend",
    }),
  ),
);
server.requestTimeout = 210000;
server.headersTimeout = 15000;
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close(async () => {
    await runtime.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 20000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
