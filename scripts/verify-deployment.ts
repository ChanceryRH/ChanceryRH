import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createPublicClient, http } from "viem";
import { RHC } from "../shared/chain.ts";
import { loadDeploymentBuild, verifyDeployment, type DeploymentReader } from "../server/deployment.ts";

const {values} = parseArgs({options: {manifest: {type: "string"}, rpc: {type: "string"}}});
if (!values.manifest) throw Error("Use --manifest /path/to/approved-deployment.json. This command never signs or broadcasts.");
const rpc = values.rpc || RHC.rpcUrls.default.http[0];
const url = new URL(rpc);
if (url.username || url.password || (url.protocol !== "https:" &&
  !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))))
  throw Error("Use an HTTPS RPC or a local fork, without credentials in the URL.");
const client = createPublicClient({chain: RHC, transport: http(rpc, {timeout: 15000, retryCount: 1})});
try {
  const result = await verifyDeployment(JSON.parse(await readFile(values.manifest, "utf8")),
    client as DeploymentReader, await loadDeploymentBuild());
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // Transport error details may include private infrastructure information.
  console.error(error instanceof Error && error.message.startsWith("Deployment mismatch:")
    ? error.message : "Deployment verification failed. Check the approved manifest and RPC privately.");
  process.exitCode = 1;
}
