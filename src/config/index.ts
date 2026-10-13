import path from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { isWithin, Sandbox } from "../security/sandbox.js";
import { WorkspaceError } from "../security/errors.js";

export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const environmentSchema = z.object({
  WORKSPACE_ROOT: z.string().min(1),
  PORT: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1024).max(65535))
    .default(3000),
});

export async function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new WorkspaceError(
      "INVALID_CONFIG",
      "Set an absolute WORKSPACE_ROOT and a PORT between 1024 and 65535.",
    );
  }
  const sandbox = await Sandbox.create(parsed.data.WORKSPACE_ROOT);
  const repository = await realpath(path.resolve(PROJECT_ROOT));
  if (
    isWithin(repository, sandbox.root) ||
    isWithin(sandbox.root, repository)
  ) {
    throw new WorkspaceError(
      "OVERLAPPING_ROOT",
      "The managed workspace and source repository must be separate directories.",
    );
  }
  return { sandbox, port: parsed.data.PORT, host: "127.0.0.1" as const };
}
