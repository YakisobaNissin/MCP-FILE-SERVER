import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import {
  Sandbox,
  validateRelativePath,
  isWithin,
} from "../src/security/sandbox.js";
import { fixture } from "./helpers.js";

describe("sandbox boundary", () => {
  let context: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    context = await fixture();
  });
  afterEach(async () => {
    await context.cleanup();
  });

  it("resolves permitted relative paths and Windows separators", async () => {
    expect(await context.sandbox.directory(".")).toBe(context.sandbox.root);
    expect(await context.sandbox.resolveExisting("projects\\hello.md")).toBe(
      path.join(context.sandbox.root, "projects", "hello.md"),
    );
  });

  it.each([
    "..",
    "../outside",
    "projects/../../outside",
    "..\\outside",
    "/etc",
    "C:\\Windows",
    "C:/Windows",
    "C:Windows",
    "\\\\server\\share",
    "\\rooted",
    "\\\\?\\C:\\Windows",
    "file:stream",
    "projects//hello.md",
    "./projects",
    "projects/./hello.md",
    "projects/",
    "projects.",
    "projects ",
    "NUL",
    "COM1.txt",
    "con",
    "hello\u0000world",
    "name*",
    "name?",
    "",
  ])("rejects unsafe path %j", (input) => {
    expect(() => validateRelativePath(input)).toThrow();
  });

  it.each([
    ".git/config",
    ".env",
    ".ssh",
    "secrets",
    "credentials.json",
    "server.pem",
    "app-token.txt",
  ])("rejects protected path %j", (input) => {
    expect(() => validateRelativePath(input)).toThrow(/protected/);
  });

  it("rejects root-prefix siblings", () => {
    expect(isWithin(context.root, `${context.root}-other`)).toBe(false);
    expect(isWithin(context.root, path.join(context.root, "projects"))).toBe(
      true,
    );
  });

  it("rejects external junctions and traversal through them", async () => {
    await symlink(
      context.outside,
      path.join(context.root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(context.sandbox.directory("escape")).rejects.toThrow(
      /links and junctions/,
    );
    await expect(
      context.sandbox.resolveExisting("escape/private.txt"),
    ).rejects.toThrow(/links and junctions/);
  });

  it("rejects internal junctions as well", async () => {
    await symlink(
      path.join(context.root, "projects"),
      path.join(context.root, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(context.sandbox.directory("alias")).rejects.toThrow(
      /links and junctions/,
    );
  });

  it("rejects a linked root and non-directory target", async () => {
    const alias = path.join(context.outside, "root-alias");
    await symlink(
      context.root,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(Sandbox.create(alias)).rejects.toThrow(/real directory/);
    await expect(context.sandbox.directory("PROJECT_STATE.md")).rejects.toThrow(
      /not a directory/,
    );
  });

  it("detects a root replaced with a junction after initialization", async () => {
    const { rename } = await import("node:fs/promises");
    const moved = path.join(context.outside, "old-root");
    await rename(context.root, moved);
    await symlink(
      context.outside,
      context.root,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(context.sandbox.directory(".")).rejects.toThrow(
      /links and junctions/,
    );
  });

  it("rejects a relative workspace root", async () => {
    await expect(Sandbox.create("relative")).rejects.toThrow(/absolute/);
  });

  it("accepts an empty real directory", async () => {
    await mkdir(path.join(context.root, "empty"));
    expect(await context.sandbox.directory("empty")).toContain("empty");
  });
});
