import { mkdir, writeFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Deliberately fixed sibling destination. Never replace existing user files.
const repository = fileURLToPath(new URL("../", import.meta.url));
const root = path.resolve(repository, "../demo-workspace");
const files = {
  "PROJECT_STATE.md":
    "# Project state\n\nMilestone: M1\nStatus: Ready for local listing verification\nObjective: Build a secure MCP file connector.\nBlockers: None for M1.\nNext: Verify list_files, then approve M2.\n",
  "PLAN_LOG/README.md":
    "# Plan log\n\nReserved for structured progress records in M4.\n",
  "CHECKPOINTS/README.md":
    "# Checkpoints\n\nReserved for handoff records in M4.\n",
  "DECISIONS/README.md":
    "# Decisions\n\nReserved for shared project decisions in M4.\n",
  "projects/welcome.md":
    "# Demo project\n\nThis safe sample is visible through the M1 list_files tool.\n",
};

async function ensureDirectory(directory) {
  try {
    await mkdir(directory);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error("Refusing a linked or non-directory workspace target.");
  const canonical = await realpath(directory);
  const relative = path.relative(root, canonical);
  if (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(
      "Workspace target resolves outside the expected sibling folder.",
    );
  }
}

try {
  await ensureDirectory(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    const parent = path.dirname(target);
    if (parent !== root) await ensureDirectory(parent);
    try {
      await writeFile(target, content, { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  console.log("Demo workspace initialized; existing files were preserved.");
} catch {
  console.error(
    "Workspace initialization failed. Check sibling-folder permissions and ensure targets are real directories.",
  );
  process.exitCode = 1;
}
