import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Server } from "node:http";
import { request } from "node:http";
import { createApp } from "../src/app.js";
import type { AuditEvent } from "../src/logging/audit.js";
import { fixture } from "./helpers.js";

describe("real MCP Streamable HTTP integration", () => {
  let context: Awaited<ReturnType<typeof fixture>>;
  let listener: Server;
  let endpoint: string;
  let closeHandler: () => Promise<void>;
  let events: AuditEvent[];
  let client: Client;

  beforeEach(async () => {
    context = await fixture();
    events = [];
    const running = createApp(context.sandbox, (event) => events.push(event));
    closeHandler = running.close;
    listener = await new Promise<Server>((resolve) => {
      const server = running.app.listen(0, "127.0.0.1", () => resolve(server));
    });
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test port");
    endpoint = `http://127.0.0.1:${address.port}/mcp`;
    client = new Client({ name: "m1-integration-test", version: "1.0.0" });
  });

  afterEach(async () => {
    await client.close();
    await closeHandler();
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await context.cleanup();
  });

  it("initializes, discovers exactly one strict tool, invokes it, and audits success", async () => {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const discovery = await client.listTools();
    expect(discovery.tools.map((tool) => tool.name)).toEqual(["list_files"]);
    expect(discovery.tools[0]!.inputSchema.additionalProperties).toBe(false);
    const result = await client.callTool({
      name: "list_files",
      arguments: { path: ".", recursive: true, limit: 50 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ returned: 3 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: "list_files",
      outcome: "success",
      returned: 3,
    });
    expect(JSON.stringify(events)).not.toContain(context.root);
  });

  it("reports traversal and missing targets as safe MCP tool errors", async () => {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    for (const [requested, code] of [
      ["../outside", "INVALID_PATH"],
      ["missing", "NOT_FOUND"],
      [".env", "PROTECTED_PATH"],
    ]) {
      const result = await client.callTool({
        name: "list_files",
        arguments: { path: requested },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(code);
      expect(JSON.stringify(result)).not.toContain(context.root);
      expect(JSON.stringify(result)).not.toContain("stack");
    }
    expect(events.map((event) => event.outcome)).toEqual([
      "error",
      "error",
      "error",
    ]);
  });

  it("rejects and audits schema violations through MCP", async () => {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const result = await client.callTool({
      name: "list_files",
      arguments: { limit: 1000 },
    });
    expect(result.isError).toBe(true);
    expect(events[0]).toMatchObject({
      outcome: "error",
      error_code: "INVALID_INPUT",
    });
  });

  it("supports the legacy 2025 initialization/discovery lifecycle", async () => {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const initialized = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-test", version: "1" },
        },
      }),
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.text()).toContain("secure-mcp-file-server");
    const discovery = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, "MCP-Protocol-Version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(discovery.status).toBe(200);
    expect(await discovery.text()).toContain("list_files");
  });

  it("serves explicit SDK v2 modern discovery, calls, and validation auditing", async () => {
    client = new Client(
      { name: "modern-m1-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect((await client.listTools()).tools[0]!.name).toBe("list_files");
    const result = await client.callTool({ name: "list_files", arguments: {} });
    expect(result.isError).not.toBe(true);
    const invalid = await client.callTool({
      name: "list_files",
      arguments: { limit: 0 },
    });
    expect(invalid.isError).toBe(true);
    expect(events.map((event) => event.outcome)).toEqual(["success", "error"]);
  });

  it("rejects hostile Host and Origin headers", async () => {
    for (const headers of [
      { Host: "attacker.example" },
      { Origin: "https://attacker.example" },
    ]) {
      // Node fetch normalizes Host to its URL. Use the raw HTTP client to
      // actually transmit the attacker-controlled Host header under test.
      const status = await new Promise<number | undefined>(
        (resolve, reject) => {
          const req = request(endpoint, { headers }, (res) => {
            res.resume();
            resolve(res.statusCode);
          });
          req.on("error", reject);
          req.end();
        },
      );
      expect(status).toBe(403);
    }
  });

  it("bounds HTTP body size and sanitizes malformed JSON errors", async () => {
    const headers = { "Content-Type": "application/json" };
    const malformed = await fetch(endpoint, {
      method: "POST",
      headers,
      body: "{ invalid private text",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).toBe('{"error":"Invalid JSON request."}');
    const large = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ payload: "x".repeat(17000) }),
    });
    expect(large.status).toBe(413);
    expect(await large.text()).not.toContain("stack");
  });
});
