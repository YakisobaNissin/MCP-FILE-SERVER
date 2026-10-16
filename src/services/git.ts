import { execFile } from "node:child_process";
import { lstat, opendir, realpath, open, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { z } from "zod/v4";
import {
  Sandbox,
  isWithin,
  validateRelativePath,
} from "../security/sandbox.js";
import { WorkspaceError } from "../security/errors.js";
import { fitsToolResult, MAX_FILE_BYTES } from "../security/limits.js";
import { gitStatusSchema, gitDiffSchema } from "../tools/schemas.js";
import { scanEntries } from "./files.js";

const MAX_GIT_BYTES = 64 * 1024;
const MAX_GIT_FILES = 200;

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  // No inherited GIT_* redirects, tracing, credential helpers, proxy settings,
  // or configuration injection. Only OS essentials needed to launch Git.
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA)$/i.test(
        key,
      )
    )
      environment[key] = value;
  }
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
  };
}

async function gitExecutable(root: string): Promise<string> {
  const searchPath =
    Object.entries(process.env).find(
      ([key]) => key.toLowerCase() === "path",
    )?.[1] ?? "";
  for (const directory of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    try {
      const candidate = await realpath(
        path.join(directory, process.platform === "win32" ? "git.exe" : "git"),
      );
      if (isWithin(root, candidate) || !(await lstat(candidate)).isFile())
        continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* continue through trusted executable search paths */
    }
  }
  throw new WorkspaceError(
    "GIT_UNAVAILABLE",
    "Install Git on the server PATH outside the managed workspace.",
  );
}

async function runGit(
  root: string,
  args: string[],
  allowTruncation = false,
): Promise<{ output: string; truncated: boolean }> {
  const executable = await gitExecutable(root);
  const fixed = [
    "--no-pager",
    "--no-optional-locks",
    "--literal-pathspecs",
    "--no-replace-objects",
    `--git-dir=${path.join(root, ".git")}`,
    `--work-tree=${root}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.attributesFile=",
    "-c",
    "color.ui=false",
  ];
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...fixed, ...args],
      {
        cwd: root,
        shell: false,
        windowsHide: true,
        env: gitEnvironment(),
        timeout: 5000,
        maxBuffer: MAX_GIT_BYTES,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) {
          if (
            allowTruncation &&
            error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
            error.message.startsWith("stdout")
          )
            return resolve({ output: stdout, truncated: true });
          const code =
            error.code === "ENOENT"
              ? "GIT_UNAVAILABLE"
              : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                ? "GIT_OUTPUT_LIMIT"
                : "GIT_FAILED";
          return reject(
            new WorkspaceError(
              code,
              "Git could not complete safely within its bounds. Check the local repository and Git installation.",
            ),
          );
        }
        resolve({ output: stdout, truncated: false });
      },
    );
  });
}

/** Require an ordinary, self-contained repository rooted exactly at WORKSPACE_ROOT. */
async function repositoryReady(sandbox: Sandbox): Promise<boolean> {
  await sandbox.directory(".");
  const directory = path.join(sandbox.root, ".git");
  try {
    await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  let examined = 0;
  async function inspect(target: string): Promise<void> {
    if (++examined > 4096)
      throw new WorkspaceError(
        "GIT_SCOPE_LIMIT",
        "Repository metadata exceeds the 4096-entry safety scan.",
      );
    const stats = await lstat(target);
    if (
      stats.isSymbolicLink() ||
      !isWithin(directory, await realpath(target)) ||
      (!stats.isDirectory() && (!stats.isFile() || stats.nlink !== 1))
    )
      throw new WorkspaceError(
        "UNSAFE_REPOSITORY",
        "Linked or unsupported Git metadata is not permitted.",
      );
    const relative = path.relative(directory, target).replaceAll("\\", "/");
    if (
      [
        "commondir",
        "config.worktree",
        "objects/info/alternates",
        "objects/info/http-alternates",
      ].includes(relative)
    )
      throw new WorkspaceError(
        "UNSAFE_REPOSITORY",
        "External/shared Git metadata is not permitted.",
      );
    if (stats.isDirectory())
      for await (const child of await opendir(target))
        await inspect(path.join(target, child.name));
  }
  const top = await lstat(directory);
  if (
    !top.isDirectory() ||
    top.isSymbolicLink() ||
    (await realpath(directory)) !== directory
  )
    throw new WorkspaceError(
      "UNSAFE_REPOSITORY",
      "The workspace must have its own real .git directory; Git files/worktrees are not supported.",
    );
  await inspect(directory);
  // Check a deliberately restricted INI subset BEFORE starting Git. Asking Git
  // to inspect hostile config could itself trigger repository discovery/includes.
  const configHandle = await open(path.join(directory, "config"), "r");
  let config: string;
  try {
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await configHandle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384)
      throw new WorkspaceError(
        "UNSAFE_REPOSITORY",
        "Git config exceeds the 16 KiB limit.",
      );
    config = new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, bytesRead),
    );
  } finally {
    await configHandle.close();
  }
  let section = "";
  for (const line of config.split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const header = /^\s*\[([a-zA-Z]+)(?:\s+"([^"\\\r\n]+)")?\]\s*$/.exec(line);
    if (header) {
      section = `${header[1]!.toLowerCase()}${header[2] ? "." + header[2].toLowerCase() : ""}`;
      if (!/^(core|user|remote\..+|branch\..+)$/.test(section))
        throw new WorkspaceError(
          "UNSAFE_REPOSITORY",
          "Git config sections outside the read-only policy are not permitted.",
        );
      continue;
    }
    const setting = /^\s*([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!setting || line.endsWith("\\"))
      throw new WorkspaceError(
        "UNSAFE_REPOSITORY",
        "Unsupported Git config syntax. Use an ordinary self-contained repository.",
      );
    const key = `${section}.${setting[1]!.toLowerCase()}`;
    const value = setting[2]!;
    const permitted =
      /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase|autocrlf|eol|safecrlf)|user\.(name|email)|remote\.[^.]+\.(url|fetch|pushurl)|branch\.[^.]+\.(remote|merge))$/.test(
        key,
      );
    if (
      !permitted ||
      (key === "core.repositoryformatversion" && value !== "0") ||
      (key === "core.bare" && value.toLowerCase() !== "false")
    )
      throw new WorkspaceError(
        "UNSAFE_REPOSITORY",
        "Repository config contains settings outside the read-only Git policy. Includes, filters, helpers and repository redirects are not permitted.",
      );
  }
  return true;
}

async function permittedFile(sandbox: Sandbox, name: string): Promise<boolean> {
  const parts = validateRelativePath(name);
  if (!parts.length || parts.some((part) => part.startsWith("-")))
    throw new WorkspaceError(
      "INVALID_PATH",
      "Git paths must identify files, not options or directories.",
    );
  try {
    const stats = await lstat(await sandbox.resolveExisting(name));
    if (!stats.isFile() || stats.nlink !== 1)
      throw new WorkspaceError(
        "NOT_FILE",
        "Git paths must be permitted regular files.",
      );
    if (stats.size > MAX_FILE_BYTES)
      throw new WorkspaceError(
        "FILE_TOO_LARGE",
        "Git file scope is limited to 256 KiB current files.",
      );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Deleted tracked paths remain reviewable; check every existing ancestor.
    for (let length = parts.length - 1; length >= 0; length--) {
      try {
        await sandbox.directory(parts.slice(0, length).join("/") || ".");
        return true;
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== "ENOENT")
          throw parentError;
      }
    }
    return false;
  }
}

async function permittedScope(sandbox: Sandbox) {
  const scan = await scanEntries(sandbox, ".", true);
  const indexed = (await runGit(sandbox.root, ["ls-files", "--stage", "-z"]))
    .output;
  const names = new Set(
    scan.found
      .filter((entry) => entry.type === "file")
      .map((entry) => entry.path),
  );
  for (const record of indexed.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab > 0 && /^100(644|755) /.test(record))
      names.add(record.slice(tab + 1));
  }
  const paths: string[] = [];
  let characters = 0;
  let truncated = scan.scanLimit || scan.depthLimit;
  for (const name of [...names].sort()) {
    try {
      if (!(await permittedFile(sandbox, name))) continue;
    } catch {
      continue;
    }
    if (paths.length >= MAX_GIT_FILES || characters + name.length > 12000) {
      truncated = true;
      break;
    }
    paths.push(name);
    characters += name.length + 3;
  }
  return { paths, truncated };
}

export async function gitStatus(
  sandbox: Sandbox,
  raw: z.input<typeof gitStatusSchema>,
) {
  const input = gitStatusSchema.parse(raw);
  return sandbox.mutate(async () => {
    if (!(await repositoryReady(sandbox)))
      return {
        repository: false,
        entries: [],
        returned: 0,
        truncated: false,
        message:
          "Workspace has no .git repository. The operator must initialize it explicitly.",
      };
    const scope = await permittedScope(sandbox);
    const output = scope.paths.length
      ? (
          await runGit(sandbox.root, [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=all",
            "--no-renames",
            "--",
            ...scope.paths,
          ])
        ).output
      : "";
    const entries: { path: string; index: string; working_tree: string }[] = [];
    for (const item of output.split("\0").filter(Boolean)) {
      const name = item.slice(3);
      try {
        if (scope.paths.includes(name) && (await permittedFile(sandbox, name)))
          entries.push({ path: name, index: item[0]!, working_tree: item[1]! });
      } catch {
        /* omit disallowed paths */
      }
    }
    const result = {
      repository: true,
      entries: entries.slice(0, input.limit),
      returned: 0,
      clean_within_scope: entries.length === 0 && !scope.truncated,
      truncated: scope.truncated || entries.length > input.limit,
    };
    result.returned = result.entries.length;
    while (!fitsToolResult(result) && result.entries.length) {
      result.entries.pop();
      result.returned--;
      result.truncated = true;
    }
    return result;
  });
}

export async function gitDiff(
  sandbox: Sandbox,
  raw: z.input<typeof gitDiffSchema>,
) {
  const input = gitDiffSchema.parse(raw);
  if (input.paths)
    for (const name of input.paths) await permittedFile(sandbox, name);
  return sandbox.mutate(async () => {
    if (!(await repositoryReady(sandbox)))
      return {
        repository: false,
        diff: "",
        truncated: false,
        message:
          "Workspace has no .git repository. The operator must initialize it explicitly.",
      };
    const scope = input.paths
      ? {
          paths: input.paths.map((name) =>
            validateRelativePath(name).join("/"),
          ),
          truncated: false,
        }
      : await permittedScope(sandbox);
    for (const name of scope.paths) await permittedFile(sandbox, name);
    const output = scope.paths.length
      ? await runGit(
          sandbox.root,
          [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-renames",
            "--ignore-submodules=all",
            "--no-relative",
            "--unified=3",
            ...(input.staged ? ["--cached"] : []),
            "--",
            ...scope.paths,
          ],
          true,
        )
      : { output: "", truncated: false };
    // Recheck before returning anything; outside-process filesystem races remain documented.
    for (const name of scope.paths) await permittedFile(sandbox, name);
    const characters = Array.from(output.output);
    const build = (length: number) => ({
      repository: true,
      staged: input.staged,
      diff: characters.slice(0, length).join(""),
      truncated:
        scope.truncated || output.truncated || length < characters.length,
      note: "Tracked changes only; untracked files are listed by git_status.",
    });
    let low = 0;
    let high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fitsToolResult(build(middle))) low = middle;
      else high = middle - 1;
    }
    return build(low);
  });
}
