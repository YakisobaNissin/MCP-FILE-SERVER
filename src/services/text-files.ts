import { constants, type Stats } from "node:fs";
import {
  open,
  lstat,
  link,
  unlink,
  rename,
  mkdir,
  writeFile,
  rmdir,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { WorkspaceError } from "../security/errors.js";
import {
  Sandbox,
  validateRelativePath,
  isDevelopmentFile,
  isWithin,
} from "../security/sandbox.js";
import {
  MAX_FILE_BYTES,
  MAX_READ_BYTES,
  BINARY_CONTROLS,
  fitsToolResult,
} from "../security/limits.js";
import {
  readFileSchema,
  writeFileSchema,
  strReplaceSchema,
  deleteFileSchema,
  createDirectorySchema,
  editFileSchema,
  moveFileSchema,
  restoreFileSchema,
} from "../tools/schemas.js";
import { z } from "zod/v4";

export const digest = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const sameFile = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
const sameVersion = (a: Stats, b: Stats): boolean =>
  sameFile(a, b) &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;

function assertRegular(stats: Stats): void {
  if (!stats.isFile())
    throw new WorkspaceError("NOT_FILE", "The target must be a regular file.");
  if (stats.nlink !== 1)
    throw new WorkspaceError(
      "HARD_LINK_NOT_ALLOWED",
      "Files with multiple hard links are not permitted.",
    );
  if (stats.size > MAX_FILE_BYTES)
    throw new WorkspaceError(
      "FILE_TOO_LARGE",
      "File exceeds the 256 KiB limit.",
    );
}

/** Bounded descriptor read, with checks before/after opening and reading. */
export interface ReadBudget {
  remaining: number;
}

export async function readSnapshot(
  sandbox: Sandbox,
  relative: string,
  budget?: ReadBudget,
) {
  const target = await sandbox.resolveExisting(relative);
  const before = await lstat(target);
  assertRegular(before);
  if (budget && before.size > budget.remaining)
    throw new WorkspaceError(
      "SEARCH_BUDGET",
      "The remaining search byte budget cannot fit this file.",
    );
  const handle = await open(
    target,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    assertRegular(opened);
    if (!sameVersion(before, opened))
      throw new WorkspaceError(
        "CONFLICT",
        "File changed while opening. Read it again.",
      );
    const buffer = Buffer.alloc(
      Math.min(MAX_FILE_BYTES + 1, budget?.remaining ?? MAX_FILE_BYTES + 1),
    );
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
      if (budget) budget.remaining -= bytesRead;
    }
    if (length > MAX_FILE_BYTES)
      throw new WorkspaceError(
        "FILE_TOO_LARGE",
        "File exceeds the 256 KiB limit.",
      );
    const after = await handle.stat();
    const checkedTarget = await sandbox.resolveExisting(relative);
    if (
      length !== after.size ||
      !sameVersion(opened, after) ||
      !sameVersion(after, await lstat(checkedTarget))
    ) {
      throw new WorkspaceError(
        "CONFLICT",
        "File changed while reading. Read it again.",
      );
    }
    const bytes = buffer.subarray(0, length);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      throw new WorkspaceError(
        "BINARY_FILE",
        "Only valid UTF-8 text files are supported.",
      );
    }
    if (BINARY_CONTROLS.test(text))
      throw new WorkspaceError(
        "BINARY_FILE",
        "Binary files are not supported.",
      );
    return { target, stats: after, bytes, text, sha256: digest(bytes) };
  } finally {
    await handle.close();
  }
}

const relativeName = (input: string) => validateRelativePath(input).join("/");

export async function readTextFile(
  sandbox: Sandbox,
  raw: z.input<typeof readFileSchema>,
) {
  const input = readFileSchema.parse(raw);
  const snapshot = await readSnapshot(sandbox, input.path);
  const lines = snapshot.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const initial = lines[input.start_line - 1] ?? "";
  if (
    input.start_column >
    Array.from(initial).length - (initial.endsWith("\n") ? 1 : 0)
  )
    throw new WorkspaceError(
      "INVALID_RANGE",
      "start_column exceeds the selected line.",
    );
  const selected = [
    Array.from(initial).slice(input.start_column).join(""),
    ...lines.slice(input.start_line, input.start_line - 1 + input.max_lines),
  ].join("");
  const characters = Array.from(selected);
  let count = 0;
  let bytes = 0;
  for (const character of characters) {
    const size = Buffer.byteLength(character);
    if (bytes + size > MAX_READ_BYTES) break;
    bytes += size;
    count++;
  }
  function resultFor(length: number) {
    const content = characters.slice(0, length).join("");
    let nextLine = input.start_line;
    let nextColumn = input.start_column;
    for (const character of characters.slice(0, length)) {
      if (character === "\n") {
        nextLine++;
        nextColumn = 0;
      } else nextColumn++;
    }
    const consumed =
      lines.slice(0, input.start_line - 1).join("").length +
      Array.from(initial).slice(0, input.start_column).join("").length +
      content.length;
    const more = consumed < snapshot.text.length;
    return {
      path: relativeName(input.path),
      content,
      sha256: snapshot.sha256,
      total_lines: lines.length,
      start_line: input.start_line,
      has_more: more,
      truncated: more,
      next_line: more ? nextLine : null,
      next_column: more ? nextColumn : null,
    };
  }
  // Exact MCP envelope sizing also accounts for escaped tabs/newlines and Unicode.
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fitsToolResult(resultFor(middle))) low = middle;
    else high = middle - 1;
  }
  return resultFor(low);
}

async function stage(parent: string, bytes: Buffer, mode: number) {
  const temporary = path.join(parent, `.mcp-tmp-${randomUUID()}`);
  const handle = await open(temporary, "wx", mode & 0o777);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  return temporary;
}

export async function writeTextFile(
  sandbox: Sandbox,
  raw: z.input<typeof writeFileSchema>,
) {
  const input = writeFileSchema.parse(raw);
  return sandbox.mutate(() =>
    createTextFile(sandbox, input.path, Buffer.from(input.content, "utf8")),
  );
}

async function createTextFile(
  sandbox: Sandbox,
  relative: string,
  bytes: Buffer,
) {
  const { target, parent } = await sandbox.creationTarget(relative);
  const temporary = await stage(parent, bytes, 0o600);
  try {
    await sandbox.creationTarget(relative);
    // Hard-link publication is exclusive: no replace and no partially written destination.
    await link(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return {
    path: relativeName(relative),
    created: true,
    size_bytes: bytes.length,
    sha256: digest(bytes),
  };
}

/** Internal append operation: caller supplies a fixed protocol path and validates old records. */
export async function appendTextFile(
  sandbox: Sandbox,
  relative: string,
  addition: string,
  validateExisting: (text: string) => void,
) {
  return sandbox.mutate(async () => {
    let snapshot: Awaited<ReturnType<typeof readSnapshot>>;
    try {
      snapshot = await readSnapshot(sandbox, relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return createTextFile(sandbox, relative, Buffer.from(addition));
    }
    validateExisting(snapshot.text);
    const bytes = Buffer.from(snapshot.text + addition);
    if (bytes.length > 64 * 1024)
      throw new WorkspaceError(
        "LOG_FULL",
        "This task/day log reached 64 KiB. Start a new task ID or archive it manually.",
      );
    const temporary = await stage(
      path.dirname(snapshot.target),
      bytes,
      snapshot.stats.mode,
    );
    try {
      await unchanged(sandbox, relative, snapshot);
      await rename(temporary, snapshot.target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return {
      path: relativeName(relative),
      created: false,
      size_bytes: bytes.length,
      sha256: digest(bytes),
    };
  });
}

async function unchanged(
  sandbox: Sandbox,
  relative: string,
  previous: Awaited<ReturnType<typeof readSnapshot>>,
) {
  const current = await readSnapshot(sandbox, relative);
  if (
    !sameVersion(previous.stats, current.stats) ||
    current.sha256 !== previous.sha256
  ) {
    throw new WorkspaceError(
      "CONFLICT",
      "File changed before the mutation. Read it again.",
    );
  }
}

function expectedHash(actual: string, expected: string): void {
  if (actual !== expected)
    throw new WorkspaceError(
      "CONFLICT",
      "File differs from expected_sha256. Read it again before changing it.",
    );
}

export async function replaceText(
  sandbox: Sandbox,
  raw: z.input<typeof strReplaceSchema>,
) {
  const input = strReplaceSchema.parse(raw);
  return sandbox.mutate(async () => {
    const snapshot = await readSnapshot(sandbox, input.path);
    expectedHash(snapshot.sha256, input.expected_sha256);
    const index = snapshot.text.indexOf(input.old_text);
    if (index < 0)
      throw new WorkspaceError(
        "NO_MATCH",
        "old_text was not found. Read the file before retrying.",
      );
    if (snapshot.text.indexOf(input.old_text, index + 1) >= 0)
      throw new WorkspaceError(
        "MULTIPLE_MATCHES",
        "old_text matches more than once. Use a larger unique selection.",
      );
    const updated =
      snapshot.text.slice(0, index) +
      input.new_text +
      snapshot.text.slice(index + input.old_text.length);
    const bytes = Buffer.from(updated, "utf8");
    if (bytes.length > MAX_FILE_BYTES)
      throw new WorkspaceError(
        "FILE_TOO_LARGE",
        "Replacement would exceed the 256 KiB file limit.",
      );
    const temporary = await stage(
      path.dirname(snapshot.target),
      bytes,
      snapshot.stats.mode,
    );
    try {
      await unchanged(sandbox, input.path, snapshot);
      await rename(temporary, snapshot.target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return {
      path: relativeName(input.path),
      replacements: 1,
      size_bytes: bytes.length,
      sha256: digest(bytes),
    };
  });
}

export async function deleteTextFile(
  sandbox: Sandbox,
  raw: z.input<typeof deleteFileSchema>,
) {
  const input = deleteFileSchema.parse(raw);
  return sandbox.mutate(async () => {
    const snapshot = await readSnapshot(sandbox, input.path);
    expectedHash(snapshot.sha256, input.expected_sha256);
    const recovery = await sandbox.recoveryDirectory();
    const recoveryId = randomUUID();
    const destination = path.join(recovery, recoveryId);
    await mkdir(destination, { mode: 0o700 });
    try {
      await writeFile(
        path.join(destination, "metadata.json"),
        JSON.stringify({
          path: relativeName(input.path),
          sha256: snapshot.sha256,
          deleted_at: new Date().toISOString(),
        }),
        { flag: "wx", mode: 0o600 },
      );
      await unchanged(sandbox, input.path, snapshot);
      await sandbox.recoveryDirectory();
      const stats = await lstat(destination);
      if (!stats.isDirectory() || stats.isSymbolicLink())
        throw new WorkspaceError(
          "UNSAFE_RECOVERY",
          "Recovery destination changed.",
        );
      await rename(snapshot.target, path.join(destination, "file"));
    } catch (error) {
      // No recursive deletion; leave any unexpected contents for the operator.
      await unlink(path.join(destination, "metadata.json")).catch(() => {});
      await rmdir(destination).catch(() => {});
      throw error;
    }
    return {
      path: relativeName(input.path),
      deleted: true,
      recoverable: true,
      recovery_id: recoveryId,
    };
  });
}

export async function createDirectory(
  sandbox: Sandbox,
  raw: z.input<typeof createDirectorySchema>,
) {
  const input = createDirectorySchema.parse(raw);
  return sandbox.mutate(async () => {
    const parts = validateRelativePath(input.path);
    if (!parts.length || isDevelopmentFile(parts.at(-1)!))
      throw new WorkspaceError(
        "INVALID_PATH",
        "Choose a non-root directory path.",
      );
    try {
      await sandbox.directory(input.path);
      return { path: relativeName(input.path), created: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const { target } = await sandbox.creationTarget(input.path);
    await mkdir(target, { mode: 0o700 });
    await sandbox.directory(input.path);
    return { path: relativeName(input.path), created: true };
  });
}

export async function editTextFile(
  sandbox: Sandbox,
  raw: z.input<typeof editFileSchema>,
) {
  const input = editFileSchema.parse(raw);
  return sandbox.mutate(async () => {
    const snapshot = await readSnapshot(sandbox, input.path);
    expectedHash(snapshot.sha256, input.expected_sha256);
    let updated = snapshot.text;
    for (const edit of input.edits) {
      const index = updated.indexOf(edit.old_text);
      if (index < 0)
        throw new WorkspaceError(
          "NO_MATCH",
          "An edit did not match. No edits were saved; read the file again.",
        );
      if (updated.indexOf(edit.old_text, index + 1) >= 0)
        throw new WorkspaceError(
          "MULTIPLE_MATCHES",
          "An edit matched more than once. No edits were saved; use a larger unique selection.",
        );
      updated =
        updated.slice(0, index) +
        edit.new_text +
        updated.slice(index + edit.old_text.length);
      if (Buffer.byteLength(updated) > MAX_FILE_BYTES)
        throw new WorkspaceError(
          "FILE_TOO_LARGE",
          "Edits would exceed the 256 KiB file limit. No edits were saved.",
        );
    }
    const bytes = Buffer.from(updated);
    const temporary = await stage(
      path.dirname(snapshot.target),
      bytes,
      snapshot.stats.mode,
    );
    try {
      await unchanged(sandbox, input.path, snapshot);
      await rename(temporary, snapshot.target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return {
      path: relativeName(input.path),
      replacements: input.edits.length,
      size_bytes: bytes.length,
      sha256: digest(bytes),
    };
  });
}

export async function moveTextFile(
  sandbox: Sandbox,
  raw: z.input<typeof moveFileSchema>,
) {
  const input = moveFileSchema.parse(raw);
  return sandbox.mutate(async () => {
    if (
      relativeName(input.source).toLowerCase() ===
      relativeName(input.destination).toLowerCase()
    )
      throw new WorkspaceError(
        "INVALID_PATH",
        "Source and destination must be different paths; case-only renames are not supported.",
      );
    const snapshot = await readSnapshot(sandbox, input.source);
    expectedHash(snapshot.sha256, input.expected_sha256);
    await sandbox.creationTarget(input.destination);
    await unchanged(sandbox, input.source, snapshot);
    const published = await createTextFile(
      sandbox,
      input.destination,
      snapshot.bytes,
    );
    // Copy-then-remove avoids overwrites and leaves a complete destination if source removal fails.
    try {
      await unchanged(sandbox, input.source, snapshot);
      await unlink(snapshot.target);
    } catch {
      return {
        source: relativeName(input.source),
        destination: published.path,
        moved: false,
        destination_created: true,
        source_removed: false,
        sha256: published.sha256,
        message:
          "Destination was created, but source removal failed or conflicted. Inspect both paths before continuing.",
      };
    }
    return {
      source: relativeName(input.source),
      destination: published.path,
      moved: true,
      destination_created: true,
      source_removed: true,
      sha256: published.sha256,
    };
  });
}

const recoveryMetadata = z.strictObject({
  path: z.string().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  deleted_at: z.string().datetime(),
});

export async function restoreTextFile(
  sandbox: Sandbox,
  raw: z.input<typeof restoreFileSchema>,
) {
  const input = restoreFileSchema.parse(raw);
  return sandbox.mutate(async () => {
    const recovery = await sandbox.recoveryDirectory();
    const directory = path.join(recovery, input.recovery_id);
    const record = await Sandbox.create(directory);
    if (!isWithin(recovery, record.root) || record.root !== directory)
      throw new WorkspaceError(
        "UNSAFE_RECOVERY",
        "Recovery record is not a real private directory.",
      );
    const metadata = await readSnapshot(record, "metadata.json");
    if (metadata.bytes.length > 4096)
      throw new WorkspaceError(
        "UNSAFE_RECOVERY",
        "Recovery metadata is too large.",
      );
    let parsed: z.infer<typeof recoveryMetadata>;
    try {
      parsed = recoveryMetadata.parse(JSON.parse(metadata.text));
    } catch {
      throw new WorkspaceError(
        "UNSAFE_RECOVERY",
        "Recovery metadata is invalid. Ask the operator to inspect it.",
      );
    }
    const snapshot = await readSnapshot(record, "file");
    if (snapshot.sha256 !== parsed.sha256)
      throw new WorkspaceError(
        "UNSAFE_RECOVERY",
        "Recovered content differs from its recorded hash.",
      );
    await sandbox.creationTarget(parsed.path);
    await sandbox.recoveryDirectory();
    await unchanged(record, "metadata.json", metadata);
    await unchanged(record, "file", snapshot);
    const published = await createTextFile(
      sandbox,
      parsed.path,
      snapshot.bytes,
    );
    let recoveryRetained = false;
    try {
      await sandbox.recoveryDirectory();
      await unchanged(record, "metadata.json", metadata);
      await unchanged(record, "file", snapshot);
      await unlink(snapshot.target);
      await unlink(metadata.target);
      await rmdir(directory);
    } catch {
      recoveryRetained = true;
    }
    return {
      ...published,
      restored: true,
      recovery_id: input.recovery_id,
      recovery_retained: recoveryRetained,
      ...(recoveryRetained
        ? {
            message:
              "File restored; recovery cleanup was incomplete. Ask the operator to inspect the recovery record.",
          }
        : {}),
    };
  });
}
