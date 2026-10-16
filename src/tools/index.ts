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
  createDirectory,
  editTextFile,
  moveTextFile,
  restoreTextFile,
} from "../services/text-files.js";
import { searchFiles } from "../services/search.js";
import { gitStatus, gitDiff } from "../services/git.js";
import { appendPlanLog, createCheckpoint } from "../services/handoff.js";
import {
  authorizeTool,
  toolPermitted,
  type AccessProfile,
} from "../security/permissions.js";
import { toolSchemas, type ToolName } from "./schemas.js";

export function createServer(
  sandbox: Sandbox,
  audit: AuditSink = stderrAudit,
  profile: AccessProfile = "inspect",
): McpServer {
  const server = new McpServer({
    name: "secure-mcp-file-server",
    version: "0.5.0",
  });
  function wrap<Input, Result extends object>(
    tool: ToolName,
    operation: (input: Input) => Promise<Result>,
  ) {
    return async (input: Input) => {
      const started = performance.now();
      try {
        authorizeTool(profile, tool, input);
        const result = await operation(input);
        if (!fitsToolResult(result))
          throw new WorkspaceError(
            "OUTPUT_LIMIT",
            "Result exceeds the output limit. Request a narrower range.",
          );
        audit({
          time: new Date().toISOString(),
          tool,
          profile,
          outcome:
            ("moved" in result && result.moved === false) ||
            ("recovery_retained" in result && result.recovery_retained === true)
              ? "partial"
              : "success",
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
          profile,
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
  if (toolPermitted(profile, "list_files"))
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
  if (toolPermitted(profile, "read_file"))
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
  if (toolPermitted(profile, "write_file"))
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
  if (toolPermitted(profile, "str_replace"))
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
  if (toolPermitted(profile, "delete_file"))
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
  if (toolPermitted(profile, "search_files"))
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
  if (toolPermitted(profile, "git_status"))
    server.registerTool(
      "git_status",
      {
        description:
          "Read compact Git status only for the workspace root repository and permitted files. No Git initialization or arbitrary commands. Private paths/links/submodules are omitted. At most 200 scoped files; inspect truncated before assuming completeness.",
        inputSchema: toolSchemas.git_status,
        annotations: readOnly,
      },
      wrap("git_status", (input) => gitStatus(sandbox, input)),
    );
  if (toolPermitted(profile, "git_diff"))
    server.registerTool(
      "git_diff",
      {
        description:
          "Read a bounded tracked-file diff in the workspace root repository. Optional exact relative file paths and staged flag. No revisions, arbitrary options, external diff/text conversion or directory comparisons. Hidden/protected paths and unsafe repositories are rejected.",
        inputSchema: toolSchemas.git_diff,
        annotations: readOnly,
      },
      wrap("git_diff", (input) => gitDiff(sandbox, input)),
    );
  if (toolPermitted(profile, "append_plan_log"))
    server.registerTool(
      "append_plan_log",
      {
        description:
          "Append one structured progress entry to the server-selected UTC task/day JSONL log under PLAN_LOG. Required task ID, role, action, result and next step. No caller-supplied filename; serialized bounded appends preserve existing valid records. Returns the path and record ID.",
        inputSchema: toolSchemas.append_plan_log,
        annotations: mutation,
      },
      wrap("append_plan_log", (input) => appendPlanLog(sandbox, input)),
    );
  if (toolPermitted(profile, "create_checkpoint"))
    server.registerTool(
      "create_checkpoint",
      {
        description:
          "Create an exclusive server-named JSON handoff checkpoint under CHECKPOINTS, referencing the current PROJECT_STATE.md hash. Supply task ID, role, summary, completed/remaining work, blockers and next steps. Read/update project state first; this tool does not update state or orchestrate agents.",
        inputSchema: toolSchemas.create_checkpoint,
        annotations: mutation,
      },
      wrap("create_checkpoint", (input) => createCheckpoint(sandbox, input)),
    );
  if (toolPermitted(profile, "create_directory"))
    server.registerTool(
      "create_directory",
      {
        description:
          "Create one workspace directory with an existing parent. An existing real directory succeeds without changes; no recursive creation or protected/link paths. Plan/report access is limited to WORKFLOWS.",
        inputSchema: toolSchemas.create_directory,
        annotations: mutation,
      },
      wrap("create_directory", (input) => createDirectory(sandbox, input)),
    );
  if (toolPermitted(profile, "edit_file"))
    server.registerTool(
      "edit_file",
      {
        description:
          "Apply 1�20 ordered exact text replacements to one file using expected_sha256 from read_file. Each match must be unique at its step. Combined edit text is limited to 16 KiB; the entire result is validated before saving. No edits are saved on validation failure.",
        inputSchema: toolSchemas.edit_file,
        annotations: { ...mutation, destructiveHint: true },
      },
      wrap("edit_file", (input) => editTextFile(sandbox, input)),
    );
  if (toolPermitted(profile, "move_file"))
    server.registerTool(
      "move_file",
      {
        description:
          "Move or rename one regular text file using its expected_sha256. Destination parent must exist; no overwrites, case-only renames, directories or links. Copies exclusively then removes source; inspect moved/source_removed and message because source removal can fail after destination creation.",
        inputSchema: toolSchemas.move_file,
        annotations: { ...mutation, destructiveHint: true },
      },
      wrap("move_file", (input) => moveTextFile(sandbox, input)),
    );
  if (toolPermitted(profile, "restore_file"))
    server.registerTool(
      "restore_file",
      {
        description:
          "Restore a deleted text file using recovery_id from delete_file and confirm:true. Validates private recovery metadata and content hash; restores only to the original permitted path with an existing parent, never overwriting. Reports incomplete recovery cleanup.",
        inputSchema: toolSchemas.restore_file,
        annotations: mutation,
      },
      wrap("restore_file", (input) => restoreTextFile(sandbox, input)),
    );
  return server;
}
