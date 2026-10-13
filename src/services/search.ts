import type { z } from "zod/v4";
import type { Sandbox } from "../security/sandbox.js";
import { fitsToolResult } from "../security/limits.js";
import { searchFilesSchema } from "../tools/schemas.js";
import { scanEntries } from "./files.js";
import { readSnapshot } from "./text-files.js";
import { WorkspaceError } from "../security/errors.js";

export const MAX_SEARCH_FILES = 100;
export const MAX_SEARCH_BYTES = 2 * 1024 * 1024;
interface Match {
  path: string;
  line?: number;
  excerpt?: string;
}

export async function searchFiles(
  sandbox: Sandbox,
  raw: z.input<typeof searchFilesSchema>,
) {
  const input = searchFilesSchema.parse(raw);
  const scan = await scanEntries(sandbox, input.path, true);
  const result = {
    path: scan.base || ".",
    mode: input.mode,
    matches: [] as Match[],
    returned: 0,
    truncated: scan.scanLimit || scan.depthLimit,
    scan_limit_reached: scan.scanLimit,
    depth_limit_reached: scan.depthLimit,
    content_limit_reached: false,
    output_limit_reached: false,
    skipped_files: 0,
  };
  const fold = (value: string) =>
    input.case_sensitive ? value : value.toLowerCase();
  const query = fold(input.query);
  let examined = 0;
  const budget = { remaining: MAX_SEARCH_BYTES };
  function add(match: Match): boolean {
    if (result.matches.length >= input.max_results) {
      result.truncated = true;
      return false;
    }
    result.matches.push(match);
    result.returned = result.matches.length;
    if (!fitsToolResult(result)) {
      result.matches.pop();
      result.returned = result.matches.length;
      result.output_limit_reached = true;
      result.truncated = true;
      return false;
    }
    return true;
  }
  for (const entry of scan.found) {
    if (entry.type !== "file") continue;
    if (input.mode === "name") {
      const filename = entry.path.split("/").at(-1)!;
      if (!fold(filename).includes(query)) continue;
    }
    if (examined >= MAX_SEARCH_FILES) {
      result.content_limit_reached = true;
      result.truncated = true;
      break;
    }
    examined++;
    let snapshot: Awaited<ReturnType<typeof readSnapshot>>;
    try {
      snapshot = await readSnapshot(sandbox, entry.path, budget);
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === "SEARCH_BUDGET") {
        result.content_limit_reached = true;
        result.truncated = true;
        break;
      }
      result.skipped_files++;
      continue;
    }
    if (input.mode === "name") {
      if (!add({ path: entry.path })) break;
      continue;
    }
    const lines = snapshot.text.split("\n");
    let full = false;
    for (const [index, line] of lines.entries()) {
      const matchIndex = fold(line).indexOf(query);
      if (matchIndex < 0) continue;
      const excerpt = Array.from(line.slice(Math.max(0, matchIndex - 40)))
        .slice(0, 160)
        .join("");
      if (!add({ path: entry.path, line: index + 1, excerpt })) {
        full = true;
        break;
      }
    }
    if (full) break;
  }
  result.returned = result.matches.length;
  return result;
}
