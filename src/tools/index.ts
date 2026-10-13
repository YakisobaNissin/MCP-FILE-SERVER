import { McpServer } from "@modelcontextprotocol/server";
import { stderrAudit, type AuditSink } from "../logging/audit.js";
import { publicError, WorkspaceError } from "../security/errors.js";
import { fitsToolResult } from "../security/limits.js";
import type { Sandbox } from "../security/sandbox.js";
import { listFiles } from "../services/files.js";
import {
  readTextFile,
  writeTextFile,
  replaceText,
  deleteTextFile,
} from "../services/text-files.js";
import { searchFiles } from "../services/search.js";
import { toolSchemas, type ToolName } from "./schemas.js";

export function createServer(
  sandbox: Sandbox,
  audit: AuditSink = stderrAudit,
): McpServer {
  const server = new McpServer({
    name: "secure-mcp-file-server",
    version: "0.2.0",
  });
  function wrap<Input, Result extends object>(
    tool: ToolName,
    operation: (input: Input) => Promise<Result>,
  ) {
    return async (input: Input) => {
      const started = performance.now();
      try {
        const result = await operation(input);
        if (!fitsToolResult(result))
          throw new WorkspaceError(
            "OUTPUT_LIMIT",
            "Result exceeds the output limit. Request a narrower range.",
          );
        audit({
          time: new Date().toISOString(),
          tool,
          outcome: "success",
          duration_ms: Math.round(performance.now() - started),
          ...("returned" in result && typeof result.returned === "number"
            ? { returned: result.returned }
            : {}),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: { ...result },
        };
      } catch (error) {
        const safe = publicError(error);
        audit({
          time: new Date().toISOString(),
          tool,
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
    };
  }
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const mutation = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };
  server.registerTool(
    "list_files",
    {
      title: "List workspace files",
      description:
        "List permitted files/directories inside the workspace with relative paths, type, byte size and modification time. Hidden/protected entries and links are omitted. Use a narrow path and next_offset; recursive scans have a 1000-entry/8-level budget.",
      inputSchema: toolSchemas.list_files,
      annotations: readOnly,
    },
    wrap("list_files", (input) => listFiles(sandbox, input)),
  );
  server.registerTool(
    "read_file",
    {
      description:
        "Read a bounded UTF-8 text range from a regular workspace file (maximum file 256 KiB). Returns sha256 for safe edits/deletes and next_line/next_column to continue long reads. Binary, linked and protected files are rejected.",
      inputSchema: toolSchemas.read_file,
      annotations: readOnly,
    },
    wrap("read_file", (input) => readTextFile(sandbox, input)),
  );
  server.registerTool(
    "write_file",
    {
      description:
        "Create a new UTF-8 text file (up to 16 KiB) in an existing workspace directory. Exclusive publication prevents overwrite; existing files, links and protected paths are rejected. No directory creation or overwrite option.",
      inputSchema: toolSchemas.write_file,
      annotations: mutation,
    },
    wrap("write_file", (input) => writeTextFile(sandbox, input)),
  );
  server.registerTool(
    "str_replace",
    {
      description:
        "Replace exactly one occurrence of old_text in an existing text file. First read_file and provide its expected_sha256; stale hashes, empty/ambiguous matches and oversized edits are rejected. Saves via a staged rename.",
      inputSchema: toolSchemas.str_replace,
      annotations: { ...mutation, destructiveHint: true },
    },
    wrap("str_replace", (input) => replaceText(sandbox, input)),
  );
  server.registerTool(
    "delete_file",
    {
      description:
        "Move one regular text file to private recovery storage. Requires confirm:true and expected_sha256 from a fresh read_file. No recursive deletion, directories, protected paths or links. Returns a recovery_id for manual operator recovery.",
      inputSchema: toolSchemas.delete_file,
      annotations: { ...mutation, destructiveHint: true },
    },
    wrap("delete_file", (input) => deleteTextFile(sandbox, input)),
  );
  server.registerTool(
    "search_files",
    {
      description:
        "Search a relative subtree for literal filename or UTF-8 content matches. Returns paths and compact line excerpts for text mode; no regex. Use a narrow path/query. Bounds: 1000 entries, 8 levels, 100 text files, 2 MiB total text, 100 results. Protected/link/binary/oversized files are skipped for content search.",
      inputSchema: toolSchemas.search_files,
      annotations: readOnly,
    },
    wrap("search_files", (input) => searchFiles(sandbox, input)),
  );
  return server;
}
