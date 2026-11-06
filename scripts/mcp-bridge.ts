/** Local stdio adapter for clients without authenticated remote HTTP support. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

async function main() {
  const endpoint = new URL(process.env.CHANCERY_MCP_URL || "");
  const token = process.env.CHANCERY_MCP_TOKEN || "";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (
    (endpoint.protocol !== "https:" &&
      !(local && endpoint.protocol === "http:")) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/mcp" ||
    !/^ch_mcp_[A-Za-z0-9_-]{43}$/.test(token)
  ) {
    throw new Error("invalid_configuration");
  }
  const remote = new Client({
    name: "chancery-local-bridge",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: "Bearer " + token } },
    // Never forward a credential through a redirect, or into OAuth discovery.
    fetch: async (url, init) => {
      if (new URL(url.toString()).href !== endpoint.href)
        throw new Error("unexpected_endpoint");
      return fetch(url, { ...init, redirect: "error" });
    },
  });
  await remote.connect(transport);
  const server = new Server(
    { name: "chancery", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () =>
    remote.listTools(),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await remote.callTool(request.params);
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Chancery could not complete the request. Check your connection and permissions.",
          },
        ],
      };
    }
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await remote.close();
    await server.close();
  };
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
  process.stdin.on("end", () => void close());
  await server.connect(new StdioServerTransport());
}
main().catch(() => {
  // Protocol stdout must never contain diagnostics, credentials, or upstream errors.
  process.stderr.write(
    "Chancery MCP connection failed. Check the endpoint and connection token.\n",
  );
  process.exitCode = 1;
});
