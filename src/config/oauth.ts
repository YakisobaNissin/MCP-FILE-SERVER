import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { isWithin } from "../security/sandbox.js";
import { WorkspaceError } from "../security/errors.js";
import type { OAuthSettings } from "../security/oauth.js";

const keySchema = z.object({
  keys: z
    .array(
      z.object({
        kty: z.literal("RSA"),
        use: z.literal("sig"),
        alg: z.literal("RS256"),
        kid: z.string().min(1),
        n: z.string().min(300),
        e: z.string().min(1),
        d: z.string().min(1),
        p: z.string().min(1),
        q: z.string().min(1),
        dp: z.string().min(1),
        dq: z.string().min(1),
        qi: z.string().min(1),
      }),
    )
    .length(1),
});

export async function loadOAuthSettings(
  filename: string | undefined,
  publicHost: string | undefined,
  repository: string,
  workspace: string,
): Promise<OAuthSettings> {
  const invalid = () =>
    new WorkspaceError(
      "INVALID_AUTH_CONFIG",
      "OAuth requires PUBLIC_HOST and a private OAUTH_KEY_FILE outside the repository and workspace. Run init:oauth first.",
    );
  if (!publicHost || !filename || !path.isAbsolute(filename)) throw invalid();
  const canonical = await realpath(filename);
  if (isWithin(repository, canonical) || isWithin(workspace, canonical))
    throw invalid();
  const stats = await lstat(filename);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    stats.size > 16384
  )
    throw invalid();
  const handle = await open(canonical, "r");
  try {
    const opened = await handle.stat();
    if (
      opened.ino !== stats.ino ||
      opened.dev !== stats.dev ||
      opened.nlink !== 1
    )
      throw invalid();
    const bytes = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16384) throw invalid();
    const parsed = keySchema.safeParse(
      JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
    );
    if (!parsed.success) throw invalid();
    return { issuer: `https://${publicHost}`, jwks: parsed.data };
  } catch {
    throw invalid();
  } finally {
    await handle.close();
  }
}
