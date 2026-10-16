import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { isWithin } from "../security/sandbox.js";
import { WorkspaceError } from "../security/errors.js";

const trustedUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.port &&
      ["claude.ai", "chatgpt.com"].includes(url.hostname) &&
      !value.includes("*")
    );
  }, "Use an exact HTTPS URL on claude.ai or chatgpt.com.");
const clientSchema = z
  .strictObject({
    name: z.enum(["Claude Web", "ChatGPT Web"]),
    metadata_url: trustedUrl,
    redirect_uri: trustedUrl,
  })
  .refine((client) => {
    const host = client.name === "Claude Web" ? "claude.ai" : "chatgpt.com";
    return (
      new URL(client.metadata_url).hostname === host &&
      new URL(client.redirect_uri).hostname === host
    );
  }, "Client identity and callback must match the selected provider.");
export type TrustedClient = z.infer<typeof clientSchema>;
export const defaultClients: TrustedClient[] = [
  {
    name: "Claude Web",
    metadata_url: "https://claude.ai/oauth/mcp-oauth-client-metadata",
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  },
];

export async function loadTrustedClients(
  filename: string | undefined,
  workspace: string,
): Promise<TrustedClient[]> {
  if (!filename) return defaultClients;
  const invalid = () =>
    new WorkspaceError(
      "INVALID_AUTH_CONFIG",
      "OAUTH_CLIENTS_FILE must be a small regular JSON file outside the workspace containing exact trusted client identities and callbacks.",
    );
  if (!path.isAbsolute(filename)) throw invalid();
  const canonical = await realpath(filename);
  if (isWithin(workspace, canonical)) throw invalid();
  const before = await lstat(filename);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > 16384
  )
    throw invalid();
  const handle = await open(canonical, "r");
  try {
    const opened = await handle.stat();
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.nlink !== 1
    )
      throw invalid();
    const bytes = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (
      bytesRead > 16384 ||
      after.size !== bytesRead ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw invalid();
    const parsed = z
      .strictObject({ clients: z.array(clientSchema).min(1).max(4) })
      .parse(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
    if (
      new Set(parsed.clients.map((client) => client.metadata_url)).size !==
        parsed.clients.length ||
      new Set(parsed.clients.map((client) => client.redirect_uri)).size !==
        parsed.clients.length
    )
      throw invalid();
    return parsed.clients;
  } catch {
    throw invalid();
  } finally {
    await handle.close();
  }
}
