import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { RequestHandler } from "express";
import { WorkspaceError } from "./errors.js";
import { isWithin } from "./sandbox.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const hash = (value: string) => createHash("sha256").update(value).digest();

export function requireTokenFormat(token: string): void {
  if (!TOKEN_PATTERN.test(token))
    throw new WorkspaceError(
      "INVALID_AUTH_CONFIG",
      "Configure a strong MCP bearer token (43–128 base64url characters).",
    );
}

/** Credentials belong outside both source control and the managed workspace. */
export async function loadBearerToken(
  filename: string | undefined,
  repository: string,
  workspace: string,
): Promise<string> {
  if (!filename || !path.isAbsolute(filename))
    throw new WorkspaceError(
      "INVALID_AUTH_CONFIG",
      "MCP_TOKEN_FILE must name an absolute private token file outside the repository and workspace.",
    );
  const canonical = await realpath(filename);
  if (isWithin(repository, canonical) || isWithin(workspace, canonical))
    throw new WorkspaceError(
      "INVALID_AUTH_CONFIG",
      "The token file must be outside the repository and managed workspace.",
    );
  const stats = await lstat(filename);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    stats.size > 256
  )
    throw new WorkspaceError(
      "INVALID_AUTH_CONFIG",
      "The token file must be a small, private regular file.",
    );
  const handle = await open(canonical, "r");
  try {
    const opened = await handle.stat();
    if (
      opened.ino !== stats.ino ||
      opened.dev !== stats.dev ||
      opened.size > 256
    )
      throw new WorkspaceError(
        "INVALID_AUTH_CONFIG",
        "The token file changed while opening.",
      );
    const bytes = Buffer.alloc(257);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 256)
      throw new WorkspaceError(
        "INVALID_AUTH_CONFIG",
        "The token file is too large.",
      );
    const token = bytes.subarray(0, bytesRead).toString("utf8").trim();
    requireTokenFormat(token);
    return token;
  } finally {
    await handle.close();
  }
}

/** Apply before JSON parsing and before every externally reachable route. */
export function bearerAuthentication(token: string): RequestHandler {
  requireTokenFormat(token);
  const expected = hash(token);
  return (req, res, next) => {
    let authorizationCount = 0;
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index]?.toLowerCase() === "authorization")
        authorizationCount++;
    }
    const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/i.exec(
      req.headers.authorization ?? "",
    );
    if (
      authorizationCount !== 1 ||
      !match ||
      !timingSafeEqual(hash(match[1]!), expected)
    ) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="mcp-file-server"');
      res.setHeader("Cache-Control", "no-store");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    next();
  };
}
