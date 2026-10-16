import { generateKeyPairSync, randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBearerToken } from "../dist/security/auth.js";
import { loadOAuthSettings } from "../dist/config/oauth.js";
import { isWithin } from "../dist/security/sandbox.js";

try {
  const repository = await realpath(
    fileURLToPath(new URL("../", import.meta.url)),
  );
  const workspace = await realpath(process.env.WORKSPACE_ROOT);
  await loadBearerToken(process.env.MCP_TOKEN_FILE, repository, workspace);
  const filename = process.env.OAUTH_KEY_FILE;
  if (!filename || !path.isAbsolute(filename)) throw new Error();
  const parent = await realpath(path.dirname(filename));
  if (isWithin(repository, parent) || isWithin(workspace, parent))
    throw new Error();
  // Reuse the existing restricted credential directory; never create a public key store.
  if (parent !== (await realpath(path.dirname(process.env.MCP_TOKEN_FILE))))
    throw new Error();
  try {
    await lstat(filename);
    await loadOAuthSettings(
      filename,
      process.env.PUBLIC_HOST,
      repository,
      workspace,
    );
    console.log("Existing private OAuth signing key preserved.");
    process.exit(0);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = {
    ...privateKey.export({ format: "jwk" }),
    use: "sig",
    alg: "RS256",
    kid: randomUUID(),
  };
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ keys: [key] }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await loadOAuthSettings(
    filename,
    process.env.PUBLIC_HOST,
    repository,
    workspace,
  );
  console.log(
    "Private OAuth signing key initialized; no credentials displayed.",
  );
} catch {
  console.error(
    "OAuth initialization failed. Check the existing private token directory, PUBLIC_HOST and OAUTH_KEY_FILE. No existing key was replaced.",
  );
  process.exitCode = 1;
}
