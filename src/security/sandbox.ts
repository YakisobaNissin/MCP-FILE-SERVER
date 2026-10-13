import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { WorkspaceError } from "./errors.js";

// A deliberately conservative policy: all hidden entries are protected, plus
// common credential stores and key/certificate/database exports.
export function isProtectedSegment(segment: string): boolean {
  const name = segment.toLowerCase();
  return (
    name.startsWith(".") ||
    /^(node_modules|credentials?|secrets?|id_rsa|id_ed25519|authorized_keys|known_hosts|desktop\.ini|thumbs\.db)$/.test(
      name,
    ) ||
    /(^|[._-])(credentials?|secrets?|tokens?)([._-]|$)/.test(name) ||
    /\.(pem|key|pfx|p12|keystore|kdbx|sqlite|db)$/.test(name)
  );
}

/** Use path.relative rather than a string prefix (root-other is not in root). */
export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/** Apply Windows rules on every platform so tests and deployments agree. */
export function validateRelativePath(input: string): string[] {
  if (input === ".") return [];
  if (!input || input.length > 512 || /[\x00-\x1f\x7f<>:"|?*]/.test(input)) {
    throw new WorkspaceError(
      "INVALID_PATH",
      "Use a relative workspace path without special characters (maximum 512 characters).",
    );
  }
  if (path.posix.isAbsolute(input) || path.win32.isAbsolute(input)) {
    throw new WorkspaceError(
      "INVALID_PATH",
      "Absolute paths are not permitted. Use a relative workspace path.",
    );
  }
  const segments = input.replaceAll("\\", "/").split("/");
  if (
    segments.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part),
    )
  ) {
    throw new WorkspaceError(
      "INVALID_PATH",
      "Empty, parent-relative, device, and ambiguous Windows path segments are not permitted.",
    );
  }
  if (segments.some(isProtectedSegment)) {
    throw new WorkspaceError(
      "PROTECTED_PATH",
      "This path is protected by the workspace policy.",
    );
  }
  return segments;
}

export class Sandbox {
  private constructor(public readonly root: string) {}

  static async create(root: string): Promise<Sandbox> {
    if (!path.isAbsolute(root))
      throw new WorkspaceError(
        "INVALID_ROOT",
        "WORKSPACE_ROOT must be absolute.",
      );
    const stats = await lstat(root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new WorkspaceError(
        "INVALID_ROOT",
        "WORKSPACE_ROOT must be a real directory, not a link or junction.",
      );
    }
    return new Sandbox(await realpath(root));
  }

  /** Check every component, including the root, before returning a target. */
  async resolveExisting(input: string): Promise<string> {
    const segments = validateRelativePath(input);
    let current = this.root;
    for (const segment of [undefined, ...segments]) {
      if (segment !== undefined) current = path.join(current, segment);
      if (!isWithin(this.root, current))
        throw new WorkspaceError(
          "OUTSIDE_WORKSPACE",
          "The path is outside the workspace.",
        );
      const stats = await lstat(current);
      if (stats.isSymbolicLink())
        throw new WorkspaceError(
          "LINK_NOT_ALLOWED",
          "Symbolic links and junctions are not permitted.",
        );
      const canonical = await realpath(current);
      if (!isWithin(this.root, canonical))
        throw new WorkspaceError(
          "OUTSIDE_WORKSPACE",
          "The path resolves outside the workspace.",
        );
      // Canonical names also need the policy: a Windows 8.3 alias must not
      // bypass protection of a hidden directory or credential filename.
      if (canonical !== this.root)
        validateRelativePath(path.relative(this.root, canonical));
    }
    return current;
  }

  async directory(input: string): Promise<string> {
    const target = await this.resolveExisting(input);
    if (!(await lstat(target)).isDirectory()) {
      throw new WorkspaceError(
        "NOT_DIRECTORY",
        "The requested path is not a directory.",
      );
    }
    return target;
  }
}
