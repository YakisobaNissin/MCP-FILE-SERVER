import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, PROJECT_ROOT } from "../src/config/index.js";
import { publicError, WorkspaceError } from "../src/security/errors.js";
import { fixture } from "./helpers.js";

describe("configuration and error privacy", () => {
  let context: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    context = await fixture();
  });
  afterEach(async () => {
    await context.cleanup();
  });

  it.each([
    {},
    { WORKSPACE_ROOT: "relative" },
    { WORKSPACE_ROOT: "C:\\missing", PORT: "0" },
    { WORKSPACE_ROOT: "C:\\missing", PORT: "3000junk" },
  ])("rejects invalid configuration %j", async (env) => {
    await expect(loadConfig(env)).rejects.toThrow();
  });
  it("rejects a workspace inside the source repository", async () => {
    await expect(loadConfig({ WORKSPACE_ROOT: context.root })).rejects.toThrow(
      /separate directories/,
    );
  });
  it("rejects a workspace containing the source repository", async () => {
    await expect(loadConfig({ WORKSPACE_ROOT: PROJECT_ROOT })).rejects.toThrow(
      /separate directories/,
    );
  });
  it("does not expose native paths or stacks", () => {
    expect(publicError(new Error("SECRET C:\\private"))).toEqual({
      code: "INTERNAL_ERROR",
      message: "The operation failed. Check the local server configuration.",
    });
    expect(
      publicError({ code: "ENOENT", path: "C:\\private" }).message,
    ).not.toContain("private");
    expect(publicError(new WorkspaceError("TEST", "Safe message"))).toEqual({
      code: "TEST",
      message: "Safe message",
    });
  });
});
