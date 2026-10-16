import path from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { isWithin, Sandbox } from "../security/sandbox.js";
import { WorkspaceError } from "../security/errors.js";
import { loadBearerToken } from "../security/auth.js";
import { loadOAuthSettings } from "./oauth.js";

export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const environmentSchema = z.object({
  WORKSPACE_ROOT: z.string().min(1),
  MCP_TOKEN_FILE: z.string().min(1).optional(),
  OAUTH_ENABLED: z.enum(["true", "false"]).default("false"),
  OAUTH_KEY_FILE: z.string().min(1).optional(),
  PUBLIC_HOST: z
    .string()
    .max(253)
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
    .optional(),
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
  const bearerToken = await loadBearerToken(
    parsed.data.MCP_TOKEN_FILE,
    repository,
    sandbox.root,
  );
  return {
    sandbox,
    port: parsed.data.PORT,
    host: "127.0.0.1" as const,
    bearerToken,
    publicHost: parsed.data.PUBLIC_HOST,
    oauth:
      parsed.data.OAUTH_ENABLED === "true"
        ? await loadOAuthSettings(
            parsed.data.OAUTH_KEY_FILE,
            parsed.data.PUBLIC_HOST,
            repository,
            sandbox.root,
          )
        : undefined,
  };
}
