import { afterEach, beforeEach, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadBearerToken } from "../src/security/auth.js";
import { createApp } from "../src/app.js";
import { fixture } from "./helpers.js";

let context: Awaited<ReturnType<typeof fixture>>;
const testToken = "test-only-" + "a".repeat(43);
beforeEach(async () => {
  context = await fixture();
});
afterEach(async () => {
  await context.cleanup();
});

it("fails closed with absent/weak auth configuration", async () => {
  expect(() => createApp(context.sandbox, { bearerToken: "" })).toThrow(
    /strong MCP bearer token/,
  );
  await expect(
    loadBearerToken(undefined, context.root, context.outside),
  ).rejects.toMatchObject({ code: "INVALID_AUTH_CONFIG" });
});

it("loads a private external token and rejects storage in either protected root", async () => {
  const external = path.join(context.root, "..", "auth-token");
  await writeFile(external, testToken, { flag: "wx" });
  expect(await loadBearerToken(external, context.root, context.outside)).toBe(
    testToken,
  );
  for (const directory of [context.root, context.outside]) {
    const internal = path.join(directory, "auth-token");
    await writeFile(internal, testToken, { flag: "wx" });
    await expect(
      loadBearerToken(internal, context.root, context.outside),
    ).rejects.toMatchObject({ code: "INVALID_AUTH_CONFIG" });
  }
});

it("rejects malformed/oversized token files without reflecting their contents", async () => {
  const external = path.join(context.root, "..", "auth-token");
  for (const value of ["private-but-too-short", "a".repeat(300)]) {
    await writeFile(external, value);
    await expect(
      loadBearerToken(external, context.root, context.outside),
    ).rejects.toMatchObject({ code: "INVALID_AUTH_CONFIG" });
  }
});
