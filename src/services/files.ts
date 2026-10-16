import { opendir, lstat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { listFilesSchema, type ListFilesInput } from "../tools/schemas.js";
import { Sandbox, validateRelativePath } from "../security/sandbox.js";

export const MAX_SCANNED_ENTRIES = 1000;
export const MAX_DEPTH = 8;
export const MAX_OUTPUT_BYTES = 32 * 1024;

export interface FileEntry {
  path: string;
  type: "file" | "directory";
  size_bytes: number;
  modified_at: string;
}

export interface Listing {
  path: string;
  entries: FileEntry[];
  returned: number;
  truncated: boolean;
  next_offset: number | null;
  scan_limit_reached: boolean;
  depth_limit_reached: boolean;
  output_limit_reached: boolean;
}

export async function scanEntries(
  sandbox: Sandbox,
  relativePath: string,
  recursive: boolean,
) {
  await sandbox.directory(relativePath);
  const base = validateRelativePath(relativePath).join("/");
  const found: FileEntry[] = [];
  let scanned = 0;
  let scanLimit = false;
  let depthLimit = false;

  async function walk(relative: string, depth: number): Promise<void> {
    const directory = await sandbox.directory(relative || ".");
    const children: Dirent[] = [];
    // opendir avoids loading an unbounded directory into memory. Even hidden
    // entries count toward the global work budget.
    const stream = await opendir(directory);
    for await (const child of stream) {
      if (scanned >= MAX_SCANNED_ENTRIES) {
        scanLimit = true;
        break;
      }
      scanned++;
      children.push(child);
    }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      if (child.isSymbolicLink()) continue;
      const childPath = relative ? `${relative}/${child.name}` : child.name;
      try {
        // The same policy covers requested paths and all discovered entries.
        const target = await sandbox.resolveExisting(childPath);
        const stats = await lstat(target);
        if (stats.isFile() && stats.nlink !== 1) continue;
        if (!stats.isDirectory() && !stats.isFile()) continue;
        found.push({
          path: childPath,
          type: stats.isDirectory() ? "directory" : "file",
          size_bytes: stats.isFile() ? stats.size : 0,
          modified_at: stats.mtime.toISOString(),
        });
        if (recursive && stats.isDirectory()) {
          if (depth >= MAX_DEPTH) depthLimit = true;
          else if (scanned < MAX_SCANNED_ENTRIES)
            await walk(childPath, depth + 1);
          else scanLimit = true;
        }
      } catch {
        // Protected, linked, unreadable, or concurrently removed entries are
        // omitted; their names and native error messages never leave the server.
      }
    }
  }

  await walk(base, 1);
  return { base, found, scanLimit, depthLimit };
}

export async function listFiles(
  sandbox: Sandbox,
  rawInput: ListFilesInput,
): Promise<Listing> {
  const input = listFilesSchema.parse(rawInput);
  const { base, found, scanLimit, depthLimit } = await scanEntries(
    sandbox,
    input.path,
    input.recursive,
  );
  const listing: Listing = {
    path: base || ".",
    entries: [],
    returned: 0,
    truncated: false,
    next_offset: null,
    scan_limit_reached: scanLimit,
    depth_limit_reached: depthLimit,
    output_limit_reached: false,
  };
  for (const entry of found.slice(input.offset, input.offset + input.limit)) {
    listing.entries.push(entry);
    // The MCP result includes both text and structuredContent. Reserve space
    // for JSON escaping, final flags/counts, and the protocol envelope.
    if (Buffer.byteLength(JSON.stringify(listing), "utf8") > 12 * 1024) {
      listing.entries.pop();
      listing.output_limit_reached = true;
      break;
    }
  }
  listing.returned = listing.entries.length;
  const hasMore = input.offset + listing.returned < found.length;
  listing.truncated = hasMore || scanLimit || depthLimit;
  listing.next_offset = hasMore ? input.offset + listing.returned : null;
  return listing;
}
