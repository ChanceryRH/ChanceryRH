import { createApp } from "./app.ts";
import { createJobs } from "./jobs.ts";
const runtime = await createApp(),
  jobs = createJobs(runtime);
let stopped = false;
process.on("SIGINT", () => {
  stopped = true;
});
process.on("SIGTERM", () => {
  stopped = true;
});
while (!stopped) {
  try {
    await jobs.tick();
  } catch (error: any) {
    console.error(
      JSON.stringify({ event: "worker_error", code: error?.code || "error" }),
    );
  }
  if (process.env.WORKER_ONCE === "true") break;
  for (let i = 0; i < 15 && !stopped; i++)
    await new Promise((r) => setTimeout(r, 1000));
}
await runtime.db.close();
