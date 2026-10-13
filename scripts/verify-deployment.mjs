import { readFile } from "node:fs/promises";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

// Only emit bounded verification facts, never headers, tokens, file content or raw errors.
const endpoint = new URL(process.argv[2] ?? "http://127.0.0.1:3000/mcp");
const allowed =
  (endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1") ||
  (endpoint.protocol === "https:" &&
    endpoint.hostname === process.env.PUBLIC_HOST);
if (
  !allowed ||
  endpoint.username ||
  endpoint.password ||
  endpoint.pathname !== "/mcp" ||
  endpoint.search ||
  endpoint.hash
) {
  console.error("Use the configured HTTPS host or loopback /mcp endpoint.");
  process.exit(1);
}
const client = new Client(
  { name: "m3-deployment-verifier", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
try {
  const token = (await readFile(process.env.MCP_TOKEN_FILE, "utf8")).trim();
  const common = { "ngrok-skip-browser-warning": "m3-verification" };
  for (const method of ["GET", "POST", "DELETE"]) {
    const response = await fetch(endpoint, {
      method,
      headers: {
        ...common,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: "{ invalid" } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (
      response.status !== 401 ||
      (await response.text()) !== '{"error":"Unauthorized"}'
    )
      throw new Error("Unauthorized boundary check failed");
  }
  const wrong = await fetch(endpoint, {
    headers: { ...common, Authorization: `Bearer ${"x".repeat(43)}` },
    signal: AbortSignal.timeout(15000),
  });
  if (wrong.status !== 401) throw new Error("Wrong token accepted");
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { ...common, Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  if (names.length !== 6) throw new Error("Unexpected tool count");
  const listing = await client.callTool({
    name: "list_files",
    arguments: { path: ".", limit: 10 },
  });
  if (listing.isError) throw new Error("Authenticated listing failed");
  const traversal = await client.callTool({
    name: "read_file",
    arguments: { path: "../outside" },
  });
  if (!traversal.isError) throw new Error("Traversal accepted");
  console.log(
    JSON.stringify({
      endpoint: endpoint.href,
      unauthenticated: "401 for GET/POST/DELETE and wrong token",
      protocol: client.getNegotiatedProtocolVersion(),
      tools: names,
      authenticated_listing: "passed",
      traversal_rejection: "passed",
    }),
  );
} catch {
  console.error(
    "Deployment verification failed; credentials and raw request errors withheld. Check endpoint availability and private configuration.",
  );
  process.exitCode = 1;
} finally {
  await client.close();
}
