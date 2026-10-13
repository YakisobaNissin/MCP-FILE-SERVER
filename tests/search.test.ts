import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { searchFiles, MAX_SEARCH_FILES } from "../src/services/search.js";
import { MAX_FILE_BYTES, fitsToolResult } from "../src/security/limits.js";
import { searchFilesSchema } from "../src/tools/schemas.js";
import { fixture } from "./helpers.js";

describe("bounded literal search", () => {
  let context: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    context = await fixture();
  });
  afterEach(async () => {
    await context.cleanup();
  });

  it("searches names and line content with literal case options", async () => {
    expect(
      (await searchFiles(context.sandbox, { query: "HELLO.MD", mode: "name" }))
        .matches,
    ).toEqual([{ path: "projects/hello.md" }]);
    expect(
      (
        await searchFiles(context.sandbox, {
          query: "HELLO",
          case_sensitive: true,
        })
      ).returned,
    ).toBe(0);
    expect(
      (await searchFiles(context.sandbox, { query: "hello" })).matches,
    ).toEqual([{ path: "projects/hello.md", line: 1, excerpt: "Hello" }]);
    expect((await searchFiles(context.sandbox, { query: ".*" })).returned).toBe(
      0,
    );
  });

  it("reports result truncation and bounds compact excerpts", async () => {
    await writeFile(
      path.join(context.root, "many.txt"),
      ("left ".repeat(100) + "match" + " right".repeat(100) + "\n").repeat(20),
    );
    const result = await searchFiles(context.sandbox, {
      query: "match",
      max_results: 3,
    });
    expect(result).toMatchObject({ returned: 3, truncated: true });
    for (const match of result.matches) {
      expect(match.excerpt!.length).toBeLessThanOrEqual(160);
      expect(match.excerpt).toContain("match");
    }
    expect(fitsToolResult(result)).toBe(true);
  });

  it("skips protected, binary, oversized, linked and outside content", async () => {
    await writeFile(path.join(context.root, ".env"), "match");
    await writeFile(
      path.join(context.root, "binary.bin"),
      Buffer.from([0, 1, 2]),
    );
    await writeFile(
      path.join(context.root, "large.txt"),
      "match".repeat(MAX_FILE_BYTES),
    );
    await symlink(
      context.outside,
      path.join(context.root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(
      (await searchFiles(context.sandbox, { query: "match" })).returned,
    ).toBe(0);
    expect(
      (await searchFiles(context.sandbox, { query: "binary", mode: "name" }))
        .returned,
    ).toBe(0);
    expect(
      (await searchFiles(context.sandbox, { query: "Do not list" })).returned,
    ).toBe(0);
  });

  it("reports the content-file work budget even with no matches", async () => {
    await Promise.all(
      Array.from({ length: MAX_SEARCH_FILES + 1 }, (_, i) =>
        writeFile(path.join(context.root, `file-${i}.txt`), "no"),
      ),
    );
    const result = await searchFiles(context.sandbox, { query: "absent" });
    expect(result).toMatchObject({
      returned: 0,
      truncated: true,
      content_limit_reached: true,
    });
  });

  it("bounds total file bytes searched", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        writeFile(
          path.join(context.root, `large-${i}.txt`),
          "a".repeat(MAX_FILE_BYTES),
        ),
      ),
    );
    expect(
      await searchFiles(context.sandbox, { query: "absent" }),
    ).toMatchObject({ truncated: true, content_limit_reached: true });
  });

  it("charges rejected binary-file reads against the total search byte budget", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        writeFile(
          path.join(context.root, `binary-${i}.bin`),
          Buffer.alloc(MAX_FILE_BYTES, 0),
        ),
      ),
    );
    const result = await searchFiles(context.sandbox, { query: "absent" });
    expect(result).toMatchObject({
      truncated: true,
      content_limit_reached: true,
      returned: 0,
    });
    expect(result.skipped_files).toBeGreaterThan(0);
  });

  it("bounds escaped excerpts by the complete serialized tool output", async () => {
    await writeFile(
      path.join(context.root, "matches.txt"),
      ("needle " + "\t".repeat(150) + "\n").repeat(100),
    );
    const result = await searchFiles(context.sandbox, {
      query: "needle",
      max_results: 100,
    });
    expect(result.output_limit_reached).toBe(true);
    expect(result.truncated).toBe(true);
    expect(fitsToolResult(result)).toBe(true);
  });

  it.each(["../outside", "C:\\Windows", ".git", "/etc"])(
    "rejects unsafe search roots: %s",
    async (requested) => {
      await expect(
        searchFiles(context.sandbox, { path: requested, query: "x" }),
      ).rejects.toThrow();
    },
  );

  it.each([
    { query: "" },
    { query: "a".repeat(257) },
    { query: "x", mode: "regex" },
    { query: "x", max_results: 101 },
    { query: "x", unexpected: true },
  ])("rejects invalid schemas", (input) => {
    expect(searchFilesSchema.safeParse(input).success).toBe(false);
  });
});
