import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "../src/security/sandbox.js";

// Always under this repository, never a real user workspace.
export async function fixture() {
  const parent = fileURLToPath(
    new URL("../.test-workspaces/", import.meta.url),
  );
  await mkdir(parent, { recursive: true });
  const base = await mkdtemp(path.join(parent, "case-"));
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await mkdir(path.join(root, "projects"));
  await writeFile(path.join(root, "PROJECT_STATE.md"), "# M1\n");
  await writeFile(path.join(root, "projects", "hello.md"), "Hello\n");
  await writeFile(path.join(outside, "private.txt"), "Do not list\n");
  return {
    root,
    outside,
    sandbox: await Sandbox.create(root),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}
