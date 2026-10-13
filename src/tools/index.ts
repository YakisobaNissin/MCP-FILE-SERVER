import { McpServer } from "@modelcontextprotocol/server";
import { stderrAudit, type AuditSink } from "../logging/audit.js";
import { publicError } from "../security/errors.js";
import type { Sandbox } from "../security/sandbox.js";
import { listFiles } from "../services/files.js";
import { listFilesSchema } from "./schemas.js";

export function createServer(
  sandbox: Sandbox,
  audit: AuditSink = stderrAudit,
): McpServer {
  const server = new McpServer({
    name: "secure-mcp-file-server",
    version: "0.1.0",
  });
  server.registerTool(
    "list_files",
    {
      title: "List workspace files",
      description:
        "List permitted files/directories inside the workspace. Returns relative paths, type, byte size and modification time. Hidden/protected entries and links are omitted. Use a narrow path and next_offset; recursive scans have a 1000-entry/8-level budget. Read-only.",
      inputSchema: listFilesSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const started = performance.now();
      try {
        const result = await listFiles(sandbox, input);
        audit({
          time: new Date().toISOString(),
          tool: "list_files",
          outcome: "success",
          duration_ms: Math.round(performance.now() - started),
          returned: result.returned,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: { ...result },
        };
      } catch (error) {
        const safe = publicError(error);
        audit({
          time: new Date().toISOString(),
          tool: "list_files",
          outcome: "error",
          duration_ms: Math.round(performance.now() - started),
          error_code: safe.code,
        });
        return {
          isError: true,
          content: [
            { type: "text" as const, text: JSON.stringify({ error: safe }) },
          ],
        };
      }
    },
  );
  return server;
}
