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
import { toolSchemas, type ToolName } from "../src/tools/schemas.js";
import { writeFile, readFile, readdir, symlink } from "node:fs/promises";
import path from "node:path";

const unusedHash = "0".repeat(64);
function argumentsFor(
  name: ToolName,
  requested: string,
): Record<string, unknown> {
  switch (name) {
    case "list_files":
      return { path: requested };
    case "read_file":
      return { path: requested };
    case "write_file":
      return { path: requested, content: "HTTP private marker" };
    case "str_replace":
      return {
        path: requested,
        old_text: "old",
        new_text: "new",
        expected_sha256: unusedHash,
      };
    case "delete_file":
      return { path: requested, confirm: true, expected_sha256: unusedHash };
    case "search_files":
      return { path: requested, query: "HTTP private marker" };
  }
}

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

  it("initializes, discovers six strict tools, invokes listing, and audits success", async () => {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const discovery = await client.listTools();
    expect(discovery.tools.map((tool) => tool.name)).toEqual([
      "list_files",
      "read_file",
      "write_file",
      "str_replace",
      "delete_file",
      "search_files",
    ]);
    for (const tool of discovery.tools)
      expect(tool.inputSchema.additionalProperties).toBe(false);
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
      body: JSON.stringify({ payload: "x".repeat(270000) }),
    });
    expect(large.status).toBe(413);
    expect(await large.text()).not.toContain("stack");
  });

  it.each(["legacy", "modern"] as const)(
    "performs every M2 operation over %s MCP HTTP",
    async (era) => {
      client = new Client(
        { name: "m2-workflow-test", version: "1.0.0" },
        era === "modern"
          ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
          : {},
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(endpoint)),
      );
      const call = (name: ToolName, args: Record<string, unknown>) =>
        client.callTool({ name, arguments: args });
      const created = await call("write_file", {
        path: "projects/http.txt",
        content: "first\nHTTP private marker\nlast",
      });
      expect(created.isError).not.toBe(true);
      const read = await call("read_file", {
        path: "projects/http.txt",
        start_line: 2,
        max_lines: 1,
      });
      expect(read.structuredContent).toMatchObject({
        content: "HTTP private marker\n",
        has_more: true,
        next_line: 3,
      });
      const initialHash = (read.structuredContent as { sha256: string }).sha256;
      const edited = await call("str_replace", {
        path: "projects/http.txt",
        old_text: "HTTP private marker",
        new_text: "done marker",
        expected_sha256: initialHash,
      });
      expect(edited.isError).not.toBe(true);
      expect(edited.structuredContent).toMatchObject({ replacements: 1 });
      const found = await call("search_files", {
        path: "projects",
        query: "done marker",
      });
      expect(found.structuredContent).toMatchObject({
        matches: [
          { path: "projects/http.txt", line: 2, excerpt: "done marker" },
        ],
      });
      const removed = await call("delete_file", {
        path: "projects/http.txt",
        confirm: true,
        expected_sha256: (edited.structuredContent as { sha256: string })
          .sha256,
      });
      expect(removed.structuredContent).toMatchObject({
        deleted: true,
        recoverable: true,
      });
      const listing = await call("list_files", { recursive: true });
      expect(JSON.stringify(listing)).not.toContain(".mcp-trash");
      expect(JSON.stringify(listing)).not.toContain("http.txt");
      expect(events.map((event) => [event.tool, event.outcome])).toEqual([
        ["write_file", "success"],
        ["read_file", "success"],
        ["str_replace", "success"],
        ["search_files", "success"],
        ["delete_file", "success"],
        ["list_files", "success"],
      ]);
      expect(JSON.stringify(events)).not.toContain("marker");
      expect(JSON.stringify(events)).not.toContain("http.txt");
      const recoveryId = (removed.structuredContent as { recovery_id: string })
        .recovery_id;
      expect(
        await readFile(
          path.join(context.root, ".mcp-trash", recoveryId, "file"),
          "utf8",
        ),
      ).toBe("first\ndone marker\nlast");
    },
  );

  it.each(Object.keys(toolSchemas) as ToolName[])(
    "rejects malicious paths for %s over HTTP",
    async (name) => {
      await symlink(
        context.outside,
        path.join(context.root, "escape"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(endpoint)),
      );
      for (const requested of [
        "../outside/private.txt",
        "C:\\Windows\\file.txt",
        "/etc/passwd",
        ".env",
        "credentials.json",
        "escape/private.txt",
      ]) {
        const result = await client.callTool({
          name,
          arguments: argumentsFor(name, requested),
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain(context.root);
        expect(JSON.stringify(result)).not.toContain("stack");
      }
      expect(events).toHaveLength(6);
      expect(
        events.every(
          (event) => event.tool === name && event.outcome === "error",
        ),
      ).toBe(true);
      expect(
        await readFile(path.join(context.outside, "private.txt"), "utf8"),
      ).toBe("Do not list\n");
      expect(await readdir(context.outside)).toEqual(["private.txt"]);
    },
  );

  it.each(Object.keys(toolSchemas) as ToolName[])(
    "rejects and audits unknown arguments for %s",
    async (name) => {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(endpoint)),
      );
      const result = await client.callTool({
        name,
        arguments: {
          ...argumentsFor(name, "PROJECT_STATE.md"),
          unexpected: "do not log",
        },
      });
      expect(result.isError).toBe(true);
      expect(events).toEqual([
        expect.objectContaining({
          tool: name,
          outcome: "error",
          error_code: "INVALID_INPUT",
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain("do not log");
    },
  );

  it("rejects unsafe overwrite, confirmation, stale-hash, binary and oversized input requests over HTTP", async () => {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    await writeFile(path.join(context.root, "binary.bin"), Buffer.from([0, 1]));
    for (const [name, args] of [
      ["write_file", { path: "PROJECT_STATE.md", content: "overwrite" }],
      ["write_file", { path: "new.txt", content: "a".repeat(16385) }],
      ["read_file", { path: "binary.bin" }],
      [
        "delete_file",
        {
          path: "PROJECT_STATE.md",
          confirm: false,
          expected_sha256: unusedHash,
        },
      ],
      [
        "delete_file",
        {
          path: "PROJECT_STATE.md",
          confirm: true,
          expected_sha256: unusedHash,
        },
      ],
      [
        "str_replace",
        {
          path: "PROJECT_STATE.md",
          old_text: "M1",
          new_text: "M2",
          expected_sha256: unusedHash,
        },
      ],
      ["read_file", { path: "missing.txt" }],
      [
        "str_replace",
        {
          path: "missing.txt",
          old_text: "old",
          new_text: "new",
          expected_sha256: unusedHash,
        },
      ],
      [
        "delete_file",
        { path: "missing.txt", confirm: true, expected_sha256: unusedHash },
      ],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
    }
    expect(
      await readFile(path.join(context.root, "PROJECT_STATE.md"), "utf8"),
    ).toBe("# M1\n");
    expect(events).toHaveLength(9);
    expect(events.every((event) => event.outcome === "error")).toBe(true);
  });
});
