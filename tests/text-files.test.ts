import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  writeFile,
  readFile,
  lstat,
  readdir,
  symlink,
  link,
} from "node:fs/promises";
import path from "node:path";
import {
  readTextFile,
  writeTextFile,
  replaceText,
  deleteTextFile,
  digest,
} from "../src/services/text-files.js";
import {
  fitsToolResult,
  MAX_FILE_BYTES,
  MAX_INPUT_BYTES,
} from "../src/security/limits.js";
import {
  readFileSchema,
  writeFileSchema,
  strReplaceSchema,
  deleteFileSchema,
} from "../src/tools/schemas.js";
import { fixture } from "./helpers.js";

describe("bounded text file services", () => {
  let context: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    context = await fixture();
  });
  afterEach(async () => {
    await context.cleanup();
  });
  const hash = (text: string) => digest(Buffer.from(text));

  it("reads line ranges, preserves CRLF and supplies a usable hash", async () => {
    await writeFile(
      path.join(context.root, "lines.txt"),
      "first\r\nsecond\r\nthird",
    );
    const result = await readTextFile(context.sandbox, {
      path: "lines.txt",
      start_line: 2,
      max_lines: 1,
    });
    expect(result).toMatchObject({
      content: "second\r\n",
      total_lines: 3,
      sha256: hash("first\r\nsecond\r\nthird"),
      has_more: true,
      next_line: 3,
      next_column: 0,
    });
    expect(
      (
        await readTextFile(context.sandbox, {
          path: "lines.txt",
          start_line: 3,
        })
      ).content,
    ).toBe("third");
  });

  it("paginates a long Unicode line without splitting or losing characters", async () => {
    const original = "🙂".repeat(5000) + "\nend";
    await writeFile(path.join(context.root, "long.txt"), original);
    let content = "";
    let line = 1;
    let column = 0;
    for (let page = 0; page < 10; page++) {
      const result = await readTextFile(context.sandbox, {
        path: "long.txt",
        start_line: line,
        start_column: column,
      });
      expect(fitsToolResult(result)).toBe(true);
      content += result.content;
      if (!result.has_more) break;
      line = result.next_line!;
      column = result.next_column!;
    }
    expect(content).toBe(original);
  });

  it("bounds heavily escaped content using the actual MCP envelope", async () => {
    await writeFile(path.join(context.root, "tabs.txt"), "\t".repeat(20000));
    const result = await readTextFile(context.sandbox, { path: "tabs.txt" });
    expect(result.has_more).toBe(true);
    expect(fitsToolResult(result)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("handles empty files and line ranges beyond EOF", async () => {
    await writeFile(path.join(context.root, "empty.txt"), "");
    expect(
      await readTextFile(context.sandbox, { path: "empty.txt" }),
    ).toMatchObject({ content: "", total_lines: 0, has_more: false });
    expect(
      await readTextFile(context.sandbox, {
        path: "PROJECT_STATE.md",
        start_line: 500,
      }),
    ).toMatchObject({ content: "", has_more: false });
    await expect(
      readTextFile(context.sandbox, {
        path: "PROJECT_STATE.md",
        start_column: 100,
      }),
    ).rejects.toMatchObject({ code: "INVALID_RANGE" });
  });

  it.each([Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xfe])])(
    "rejects binary/non-UTF-8 files",
    async (bytes) => {
      await writeFile(path.join(context.root, "binary.bin"), bytes);
      await expect(
        readTextFile(context.sandbox, { path: "binary.bin" }),
      ).rejects.toMatchObject({ code: "BINARY_FILE" });
    },
  );

  it("rejects oversized files before an unbounded read", async () => {
    await writeFile(
      path.join(context.root, "big.txt"),
      Buffer.alloc(MAX_FILE_BYTES + 1, 65),
    );
    await expect(
      readTextFile(context.sandbox, { path: "big.txt" }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("creates an exclusive complete file and leaves no staging files", async () => {
    const result = await writeTextFile(context.sandbox, {
      path: "projects/new.md",
      content: "new content",
    });
    expect(result).toMatchObject({
      created: true,
      sha256: hash("new content"),
    });
    expect(
      await readFile(path.join(context.root, "projects/new.md"), "utf8"),
    ).toBe("new content");
    expect(
      (await lstat(path.join(context.root, "projects/new.md"))).nlink,
    ).toBe(1);
    expect(
      (await readdir(path.join(context.root, "projects"))).some((name) =>
        name.startsWith(".mcp-tmp"),
      ),
    ).toBe(false);
    await expect(
      writeTextFile(context.sandbox, {
        path: "projects/new.md",
        content: "overwrite",
      }),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    expect(
      await readFile(path.join(context.root, "projects/new.md"), "utf8"),
    ).toBe("new content");
  });

  it("rejects missing creation parents and directory targets", async () => {
    await expect(
      writeTextFile(context.sandbox, { path: "missing/file.txt", content: "" }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readTextFile(context.sandbox, { path: "projects" }),
    ).rejects.toMatchObject({ code: "NOT_FILE" });
    await expect(
      deleteTextFile(context.sandbox, {
        path: "projects",
        confirm: true,
        expected_sha256: hash(""),
      }),
    ).rejects.toMatchObject({ code: "NOT_FILE" });
  });

  it("allows only one winner among concurrent create requests", async () => {
    const results = await Promise.allSettled(
      ["one", "two"].map((content) =>
        writeTextFile(context.sandbox, { path: "race.txt", content }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  it("replaces exactly one match while preserving BOM and other bytes", async () => {
    const original = "\ufefffirst\r\nHello\r\nlast";
    await writeFile(path.join(context.root, "edit.txt"), original);
    const result = await replaceText(context.sandbox, {
      path: "edit.txt",
      old_text: "Hello",
      new_text: "World",
      expected_sha256: hash(original),
    });
    expect(result.replacements).toBe(1);
    expect(await readFile(path.join(context.root, "edit.txt"), "utf8")).toBe(
      "\ufefffirst\r\nWorld\r\nlast",
    );
  });

  it.each([
    ["absent", "NO_MATCH"],
    ["aa", "MULTIPLE_MATCHES"],
  ])(
    "rejects missing/overlapping ambiguous matches",
    async (old_text, code) => {
      await writeFile(path.join(context.root, "edit.txt"), "aaa");
      await expect(
        replaceText(context.sandbox, {
          path: "edit.txt",
          old_text,
          new_text: "X",
          expected_sha256: hash("aaa"),
        }),
      ).rejects.toMatchObject({ code });
      expect(await readFile(path.join(context.root, "edit.txt"), "utf8")).toBe(
        "aaa",
      );
    },
  );

  it("rejects stale hashes for edits and deletion", async () => {
    for (const operation of [
      () =>
        replaceText(context.sandbox, {
          path: "PROJECT_STATE.md",
          old_text: "M1",
          new_text: "M2",
          expected_sha256: hash("old"),
        }),
      () =>
        deleteTextFile(context.sandbox, {
          path: "PROJECT_STATE.md",
          confirm: true,
          expected_sha256: hash("old"),
        }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(
      await readFile(path.join(context.root, "PROJECT_STATE.md"), "utf8"),
    ).toBe("# M1\n");
  });

  it("serializes edits so stale simultaneous requests cannot overwrite each other", async () => {
    const results = await Promise.allSettled(
      ["M2", "M3"].map((new_text) =>
        replaceText(context.sandbox, {
          path: "PROJECT_STATE.md",
          old_text: "M1",
          new_text,
          expected_sha256: hash("# M1\n"),
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "CONFLICT" } });
  });

  it("rejects replacement growth beyond the file limit", async () => {
    const original = "A" + "x".repeat(MAX_FILE_BYTES - 1);
    await writeFile(path.join(context.root, "full.txt"), original);
    await expect(
      replaceText(context.sandbox, {
        path: "full.txt",
        old_text: "A",
        new_text: "AA",
        expected_sha256: hash(original),
      }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("requires delete confirmation and moves only the chosen file into recovery", async () => {
    await expect(
      deleteTextFile(context.sandbox, {
        path: "PROJECT_STATE.md",
        confirm: false as unknown as true,
        expected_sha256: hash("# M1\n"),
      }),
    ).rejects.toThrow();
    const result = await deleteTextFile(context.sandbox, {
      path: "PROJECT_STATE.md",
      confirm: true,
      expected_sha256: hash("# M1\n"),
    });
    expect(result).toMatchObject({ deleted: true, recoverable: true });
    await expect(
      lstat(path.join(context.root, "PROJECT_STATE.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const recovered = path.join(context.root, ".mcp-trash", result.recovery_id);
    expect(await readFile(path.join(recovered, "file"), "utf8")).toBe("# M1\n");
    expect(
      JSON.parse(await readFile(path.join(recovered, "metadata.json"), "utf8")),
    ).toMatchObject({ path: "PROJECT_STATE.md", sha256: hash("# M1\n") });
    await expect(
      readTextFile(context.sandbox, {
        path: `.mcp-trash/${result.recovery_id}/file`,
      }),
    ).rejects.toMatchObject({ code: "PROTECTED_PATH" });
  });

  it("refuses a junction as recovery storage, preserving the original", async () => {
    await symlink(
      context.outside,
      path.join(context.root, ".mcp-trash"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      deleteTextFile(context.sandbox, {
        path: "PROJECT_STATE.md",
        confirm: true,
        expected_sha256: hash("# M1\n"),
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_RECOVERY" });
    expect(
      await readFile(path.join(context.root, "PROJECT_STATE.md"), "utf8"),
    ).toBe("# M1\n");
    expect(await readdir(context.outside)).toEqual(["private.txt"]);
  });

  it("rejects hard-link aliases for reading and mutations", async () => {
    await link(
      path.join(context.outside, "private.txt"),
      path.join(context.root, "alias.txt"),
    );
    for (const operation of [
      () => readTextFile(context.sandbox, { path: "alias.txt" }),
      () =>
        replaceText(context.sandbox, {
          path: "alias.txt",
          old_text: "Do",
          new_text: "No",
          expected_sha256: hash("Do not list\n"),
        }),
      () =>
        deleteTextFile(context.sandbox, {
          path: "alias.txt",
          confirm: true,
          expected_sha256: hash("Do not list\n"),
        }),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: "HARD_LINK_NOT_ALLOWED",
      });
    }
  });

  it.each([
    "../outside/private.txt",
    "C:\\Windows\\file.txt",
    "/etc/passwd",
    ".env",
    "credentials.json",
    "projects/../x.txt",
  ])(
    "enforces shared path policy for every mutation/read: %s",
    async (requested) => {
      for (const operation of [
        () => readTextFile(context.sandbox, { path: requested }),
        () => writeTextFile(context.sandbox, { path: requested, content: "" }),
        () =>
          replaceText(context.sandbox, {
            path: requested,
            old_text: "x",
            new_text: "y",
            expected_sha256: hash(""),
          }),
        () =>
          deleteTextFile(context.sandbox, {
            path: requested,
            confirm: true,
            expected_sha256: hash(""),
          }),
      ])
        await expect(operation()).rejects.toThrow();
    },
  );

  it("blocks junction escapes for reads, creation, replacement, and deletion", async () => {
    await symlink(
      context.outside,
      path.join(context.root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const operation of [
      () => readTextFile(context.sandbox, { path: "escape/private.txt" }),
      () =>
        writeTextFile(context.sandbox, { path: "escape/new.txt", content: "" }),
      () =>
        replaceText(context.sandbox, {
          path: "escape/private.txt",
          old_text: "Do",
          new_text: "No",
          expected_sha256: hash("Do not list\n"),
        }),
      () =>
        deleteTextFile(context.sandbox, {
          path: "escape/private.txt",
          confirm: true,
          expected_sha256: hash("Do not list\n"),
        }),
    ])
      await expect(operation()).rejects.toMatchObject({
        code: "LINK_NOT_ALLOWED",
      });
    expect(
      await readFile(path.join(context.outside, "private.txt"), "utf8"),
    ).toBe("Do not list\n");
    expect(await readdir(context.outside)).toEqual(["private.txt"]);
  });

  it("rejects final file symlinks for all file tools, including creation", async ({
    skip,
  }) => {
    try {
      await symlink(
        path.join(context.outside, "private.txt"),
        path.join(context.root, "file-link.txt"),
        "file",
      );
    } catch (error) {
      if (
        process.platform === "win32" &&
        (error as NodeJS.ErrnoException).code === "EPERM"
      ) {
        skip(
          "Windows file-symlink creation requires Developer Mode or symlink privileges. Real junction tests still execute.",
        );
        return;
      }
      throw error;
    }
    for (const operation of [
      () => readTextFile(context.sandbox, { path: "file-link.txt" }),
      () =>
        writeTextFile(context.sandbox, {
          path: "file-link.txt",
          content: "overwrite",
        }),
      () =>
        replaceText(context.sandbox, {
          path: "file-link.txt",
          old_text: "Do",
          new_text: "No",
          expected_sha256: hash("Do not list\n"),
        }),
      () =>
        deleteTextFile(context.sandbox, {
          path: "file-link.txt",
          confirm: true,
          expected_sha256: hash("Do not list\n"),
        }),
    ])
      await expect(operation()).rejects.toMatchObject({
        code: "LINK_NOT_ALLOWED",
      });
    expect(
      await readFile(path.join(context.outside, "private.txt"), "utf8"),
    ).toBe("Do not list\n");
  });

  it.each([
    [readFileSchema, { path: "x", start_line: 0 }],
    [readFileSchema, { path: "x", max_lines: 501 }],
    [writeFileSchema, { path: "x", content: "x", overwrite: true }],
    [writeFileSchema, { path: "x", content: "🙂".repeat(MAX_INPUT_BYTES / 2) }],
    [writeFileSchema, { path: "x", content: "\u0000" }],
    [writeFileSchema, { path: "x", content: "\ud800" }],
    [
      strReplaceSchema,
      {
        path: "x",
        old_text: "",
        new_text: "x",
        expected_sha256: "a".repeat(64),
      },
    ],
    [
      strReplaceSchema,
      { path: "x", old_text: "x", new_text: "x", expected_sha256: "invalid" },
    ],
    [deleteFileSchema, { path: "x", expected_sha256: "a".repeat(64) }],
  ])("strictly rejects invalid input", (schema, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});
