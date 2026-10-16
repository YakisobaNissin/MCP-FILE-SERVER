import { lstat, realpath, mkdir } from "node:fs/promises";
import path from "node:path";
import { WorkspaceError } from "./errors.js";

// A deliberately conservative policy: all hidden entries are protected, plus
// common credential stores and key/certificate/database exports.
export function isDevelopmentFile(segment: string): boolean {
  return [".gitignore", ".editorconfig", ".prettierrc.json"].includes(
    segment.toLowerCase(),
  );
}

export function isProtectedSegment(segment: string): boolean {
  const name = segment.toLowerCase();
  if (isDevelopmentFile(name)) return false;
  return (
    name.startsWith(".") ||
    /^(node_modules|credentials?|secrets?|passwords?|passwd|kubeconfig|id_rsa|id_dsa|id_ecdsa|id_ed25519|authorized_keys|known_hosts|desktop\.ini|thumbs\.db)$/.test(
      name,
    ) ||
    /(^|[._-])(credentials?|secrets?|tokens?|passwords?|passwd)([._-]|$)/.test(
      name,
    ) ||
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
  if (
    segments.some(isProtectedSegment) ||
    segments.slice(0, -1).some(isDevelopmentFile)
  ) {
    throw new WorkspaceError(
      "PROTECTED_PATH",
      "This path is protected by the workspace policy.",
    );
  }
  return segments;
}

export class Sandbox {
  private constructor(public readonly root: string) {}
  private mutationTail: Promise<void> = Promise.resolve();

  /** Serialize this server's mutations across all per-request MCP instances. */
  async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

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
      if (stats.isDirectory() && isDevelopmentFile(path.basename(current)))
        throw new WorkspaceError(
          "PROTECTED_PATH",
          "Development dotfile exceptions apply to files, not directories.",
        );
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

  async creationTarget(
    input: string,
  ): Promise<{ target: string; parent: string }> {
    const parts = validateRelativePath(input);
    if (parts.length === 0)
      throw new WorkspaceError(
        "NOT_FILE",
        "Choose a file path, not the workspace root.",
      );
    const parent = await this.directory(parts.slice(0, -1).join("/") || ".");
    const target = path.join(parent, parts.at(-1)!);
    try {
      await lstat(target);
      // Validate existing links/protected canonical aliases before returning a conflict.
      await this.resolveExisting(input);
      throw new WorkspaceError(
        "ALREADY_EXISTS",
        "The target already exists. Overwriting is not supported.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { target, parent };
  }

  async ensureHandoffDirectory(
    name: "PLAN_LOG" | "CHECKPOINTS",
  ): Promise<void> {
    await this.directory(".");
    try {
      await mkdir(path.join(this.root, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await this.directory(name);
  }

  /** Internal-only recovery location. User-supplied hidden paths stay blocked. */
  async recoveryDirectory(): Promise<string> {
    await this.directory(".");
    const target = path.join(this.root, ".mcp-trash");
    try {
      await mkdir(target, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stats = await lstat(target);
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      (await realpath(target)) !== target
    ) {
      throw new WorkspaceError(
        "UNSAFE_RECOVERY",
        "The recovery directory must be a real workspace directory.",
      );
    }
    await this.directory(".");
    return target;
  }
}
