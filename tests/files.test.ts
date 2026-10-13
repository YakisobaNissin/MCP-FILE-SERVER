import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import {
  listFiles,
  MAX_OUTPUT_BYTES,
  MAX_SCANNED_ENTRIES,
} from "../src/services/files.js";
import { listFilesSchema } from "../src/tools/schemas.js";
import { fixture } from "./helpers.js";

describe("list_files service and schema", () => {
  let context: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    context = await fixture();
  });
  afterEach(async () => {
    await context.cleanup();
  });
  const input = (value: unknown = {}) => listFilesSchema.parse(value);

  it("lists metadata without file content or absolute paths", async () => {
    const result = await listFiles(context.sandbox, input());
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "PROJECT_STATE.md",
      "projects",
    ]);
    expect(result.entries[0]).toMatchObject({ type: "file", size_bytes: 5 });
    expect(result.entries[1]).toMatchObject({
      type: "directory",
      size_bytes: 0,
    });
    expect(Date.parse(result.entries[0]!.modified_at)).not.toBeNaN();
    expect(result.truncated).toBe(false);
    expect(JSON.stringify(result)).not.toContain(context.root);
  });

  it("recurses and returns workspace-relative child paths", async () => {
    const result = await listFiles(context.sandbox, input({ recursive: true }));
    expect(result.entries.map((entry) => entry.path)).toContain(
      "projects/hello.md",
    );
    const narrow = await listFiles(
      context.sandbox,
      input({ path: "projects" }),
    );
    expect(narrow.entries.map((entry) => entry.path)).toEqual([
      "projects/hello.md",
    ]);
  });

  it("paginates without duplicates on an unchanged directory", async () => {
    const first = await listFiles(context.sandbox, input({ limit: 1 }));
    expect(first).toMatchObject({
      returned: 1,
      truncated: true,
      next_offset: 1,
    });
    const second = await listFiles(
      context.sandbox,
      input({ limit: 1, offset: first.next_offset }),
    );
    expect(second.next_offset).toBeNull();
    expect(second.entries[0]!.path).not.toBe(first.entries[0]!.path);
    expect(
      (await listFiles(context.sandbox, input({ offset: 1000 }))).entries,
    ).toEqual([]);
  });

  it("omits hidden/protected entries and external links even during recursion", async () => {
    await writeFile(path.join(context.root, ".env"), "secret");
    await writeFile(path.join(context.root, "credentials.json"), "{}");
    await mkdir(path.join(context.root, ".git"));
    await symlink(
      context.outside,
      path.join(context.root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await listFiles(context.sandbox, input({ recursive: true }));
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "PROJECT_STATE.md",
      "projects",
      "projects/hello.md",
    ]);
  });

  it("limits scanning even when entries are protected", async () => {
    const hidden = Array.from(
      { length: MAX_SCANNED_ENTRIES + 1 },
      (_, index) => `.hidden-${index}`,
    );
    await Promise.all(
      hidden.map((name) => writeFile(path.join(context.root, name), "")),
    );
    const result = await listFiles(context.sandbox, input());
    expect(result.scan_limit_reached).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.returned).toBeLessThanOrEqual(100);
  });

  it("bounds recursion depth", async () => {
    let directory = context.root;
    for (let index = 0; index < 12; index++) {
      directory = path.join(directory, "deep");
      await mkdir(directory);
    }
    const result = await listFiles(context.sandbox, input({ recursive: true }));
    expect(result.depth_limit_reached).toBe(true);
    expect(
      result.entries.every((entry) => entry.path.split("/").length <= 8),
    ).toBe(true);
  });

  it("bounds serialized MCP output and supplies continuation", async () => {
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        writeFile(
          path.join(
            context.root,
            `${String(i).padStart(3, "0")}-${"x".repeat(180)}.md`,
          ),
          "",
        ),
      ),
    );
    const result = await listFiles(context.sandbox, input({ limit: 100 }));
    const envelope = {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(
      MAX_OUTPUT_BYTES,
    );
    expect(result.output_limit_reached).toBe(true);
    expect(result.next_offset).toBe(result.returned);
  });

  it("returns an empty listing and useful missing-directory failure", async () => {
    await mkdir(path.join(context.root, "empty"));
    expect(
      (await listFiles(context.sandbox, input({ path: "empty" }))).returned,
    ).toBe(0);
    await expect(
      listFiles(context.sandbox, input({ path: "missing" })),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: "2" },
    { offset: -1 },
    { offset: 1001 },
    { recursive: "true" },
    { path: "" },
    { path: "a".repeat(513) },
    { unknown: true },
    null,
  ])("rejects invalid arguments %j", (value) => {
    expect(() => input(value)).toThrow();
  });
});
