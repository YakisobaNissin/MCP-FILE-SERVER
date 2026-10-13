# M1 security model

## Boundary and policy

Treat every tool argument as untrusted. `WORKSPACE_ROOT` is selected by the operator, must exist as a real directory, and is canonicalized before use. The managed root and source repository must be disjoint. `path.relative` checks containment rather than string prefixes; a `workspace-other` sibling cannot pass as a child of `workspace`.

Path validation applies Windows rules even on other test platforms. It rejects absolute, drive-relative, UNC, extended namespace, parent-relative, dot/empty-segment, alternate-data-stream, control-character, wildcard, device, and trailing-dot/space paths. Every existing path component receives `lstat`, link rejection, `realpath`, and containment checks. The canonical names receive the protected-name policy too, so short-name aliases cannot intentionally bypass that policy.

All dot-prefixed entries (including `.git`, `.env`, `.ssh`, `.aws`, `.codex`, and `.agents`) are protected. The conservative policy also excludes `node_modules`, common secret/credential/token names, private key/certificate exports and database extensions. Protected subtrees are not traversed. Requested protected paths fail; discovered protected entries are silently omitted. Symlinks and junctions are rejected even when their target is inside the root. The listing service never reads file contents.

The HTTP server binds explicitly to loopback and the official Express adapter checks Host and Origin. JSON request bodies are limited to 16 KiB. Traversal has entry/depth bounds, and results have count/byte bounds. MCP error results sanitize native filesystem failures. JSONL audits omit paths, arguments, contents, raw errors, tokens and headers.

## Limits and tradeoffs

- **No endpoint authentication in M1.** Any process/user able to reach this loopback endpoint can list permitted workspace metadata. Host/Origin checks are browser defenses, not credentials. Do not create a tunnel, reverse proxy, or public binding. M3 must implement authentication before remote exposure.
- Ordinary Node pathname APIs cannot atomically bind all checks and later filesystem operations. A hostile local process that can rename directories or swap links may race `lstat`/`realpath`/`opendir`. Rechecks reduce exposure but do not eliminate TOCTOU races. Use a trusted workspace with OS permissions excluding untrusted local writers. Stronger isolation requires OS-enforced boundaries or handle-relative native APIs.
- Symlink and Windows junction tests execute on real temporary directories. Other reparse-point types, network filesystems, mount points, and exotic platform behavior have not been certified. Avoid them for this assignment.
- A denylist does not identify every possible secret filename or hard-link alias. Never place private credentials in the managed workspace. Read-only metadata can still reveal names and sizes. This tool is not a secure secret scanner.
- Offset pagination may repeat or omit entries if the filesystem changes. Large-directory scans deliberately stop; narrow paths are needed for efficient access. Recursive errors below a valid root may omit unreadable subtrees without full enumeration.
- Budgets bound traversal and output, not request rate or the duration of an OS call. M1 has no remote rate limiting or request concurrency cap.
- Audits are local stderr records without integrity guarantees or durable rotation. HTTP schema-invalid calls to the known tool are recorded; malformed protocol requests that cannot be identified as tool calls are transport errors rather than tool audit events.
- There are no write/delete/Git capabilities in M1. Future mutation tools require their own overwrite, permission, race and destructive-action controls.

These are explicit deployment constraints, not a claim of an OS sandbox. Do not weaken canonical checks to accommodate restricted execution environments.
