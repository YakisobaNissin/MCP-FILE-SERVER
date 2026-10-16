import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolName } from "../tools/schemas.js";
import { validateRelativePath } from "./sandbox.js";
import { WorkspaceError } from "./errors.js";

export const profileScopes = {
  inspect: "workspace:read",
  report: "workspace:report",
  edit: "workspace:edit",
} as const;
export type AccessProfile = keyof typeof profileScopes;
export const workspaceScopes = Object.values(profileScopes);
export const requestAccess = new AsyncLocalStorage<AccessProfile>();

const readers = new Set<ToolName>([
  "list_files",
  "read_file",
  "search_files",
  "git_status",
  "git_diff",
]);
const reporters = new Set<ToolName>([
  ...readers,
  "write_file",
  "str_replace",
  "edit_file",
  "create_directory",
  "append_plan_log",
  "create_checkpoint",
]);

export function profileFromScopes(
  scopes: Set<string>,
): AccessProfile | undefined {
  // A grant represents exactly one owner-selected profile, never an ambiguous union.
  const matches = (Object.keys(profileScopes) as AccessProfile[]).filter(
    (profile) => scopes.has(profileScopes[profile]),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function toolPermitted(profile: AccessProfile, tool: ToolName): boolean {
  return (
    profile === "edit" || (profile === "report" ? reporters : readers).has(tool)
  );
}

export function authorizeTool(
  profile: AccessProfile,
  tool: ToolName,
  input: unknown,
): void {
  const denied = () =>
    new WorkspaceError(
      "FORBIDDEN",
      "This credential does not permit that operation or write location.",
    );
  if (!toolPermitted(profile, tool)) throw denied();
  if (
    profile !== "report" ||
    readers.has(tool) ||
    tool === "append_plan_log" ||
    tool === "create_checkpoint"
  )
    return;
  const relative = (input as { path?: unknown } | null)?.path;
  if (typeof relative !== "string") throw denied();
  const parts = validateRelativePath(relative).map((part) =>
    part.toLowerCase(),
  );
  const document =
    parts[0] === "workflows" &&
    parts.length > 1 &&
    /\.(md|txt|json)$/.test(parts.at(-1)!);
  const directory = tool === "create_directory" && parts[0] === "workflows";
  const state =
    tool !== "create_directory" &&
    parts.length === 1 &&
    parts[0] === "project_state.md";
  if (!(directory || (tool !== "create_directory" && document) || state))
    throw denied();
}
