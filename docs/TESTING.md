# M1 verification

Run from the source repository:

```powershell
npm ci
npm run build
npm run typecheck
npm test
npm run format:check
```

Tests create randomly named fixture directories beneath the ignored `.test-workspaces` folder and clean up their own fixtures. They do not modify real user projects or the demo workspace. Windows junction fixtures use the real filesystem; failures are not silently skipped. Server tests listen on an OS-assigned loopback port and close clients/listeners afterward.

## Automated coverage

- Allowed root/child listing, metadata, recursion, empty/missing directories.
- Parent traversal with both separator styles, POSIX/Windows absolute paths, drive-relative paths, UNC and extended paths, control characters, ADS, device names and ambiguous segments.
- Protected targets and omission during discovery.
- External and internal junction rejection, traversal through junctions, linked-root rejection, root-link replacement after initialization, and root-prefix siblings.
- Strict schemas, unknown keys, numeric bounds, oversized paths and invalid argument types.
- Pagination, 1000-entry scan cap, 8-level recursion cap, serialized MCP output below 32 KiB with long filenames.
- Configuration validation and source/workspace overlap rejection.
- Native error sanitization and content-free success/error audit events, including SDK schema rejection.
- Real HTTP SDK client initialization/discovery/calls, explicit modern protocol negotiation and legacy 2025 compatibility.
- Host/Origin rejection using a raw HTTP client, malformed JSON and HTTP request-body limits.

These tests cover the M1 boundary, not future mutation, deletion, Git, authentication, deployment or handoff behavior. Canonical-name checking is implemented but a real Windows 8.3 alias fixture is not included; availability depends on volume settings. General link-race elimination is not claimed.

## Inspector and built-server evidence

On **2026-10-13 (Asia/Manila)** the compiled server was started using:

```powershell
$env:WORKSPACE_ROOT = 'C:\MCPAssignment\demo-workspace'
npm start
```

The official Inspector **2.10.1 CLI** was then run against `http://127.0.0.1:3000/mcp`:

```powershell
npx --yes @modelcontextprotocol/inspector@2.10.1 --cli http://127.0.0.1:3000/mcp --transport http --method tools/list
npx --yes @modelcontextprotocol/inspector@2.10.1 --cli http://127.0.0.1:3000/mcp --transport http --method tools/call --tool-name list_files --tool-arg path=. --tool-arg recursive=true --tool-arg limit=50
npx --yes @modelcontextprotocol/inspector@2.10.1 --cli http://127.0.0.1:3000/mcp --transport http --method tools/call --tool-name list_files --tool-arg path=../outside
```

Observed outcomes:

| Check             | Observation                                                       | Captured evidence                                           |
| ----------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| Tool discovery    | Exit 0, exactly one tool, strict schema and read-only annotations | [inspector-list.json](evidence/inspector-list.json)         |
| Recursive listing | Exit 0, nine permitted sample entries, no truncation              | [inspector-call.json](evidence/inspector-call.json)         |
| Traversal attempt | MCP result `isError: true`, `INVALID_PATH`, CLI exit 1            | [inspector-traversal.txt](evidence/inspector-traversal.txt) |

**CLI caveat:** after displaying the expected traversal rejection, Inspector/Node printed a Windows libuv assertion (`UV_HANDLE_CLOSING`) during exit. This negative-case Inspector run is not recorded as a clean CLI lifecycle pass. The server continued responding, and automated HTTP error tests verify rejection independently. Positive Inspector discovery and invocation exited normally. No dependency patch or assertion suppression was applied.

The Inspector browser UI was **not exercised**. The GUI startup command and manual verification steps are in the README. Codex has **not** been connected to this custom connector; native Codex filesystem operations used to build this project are not MCP integration evidence. No multi-session transcript or screenshot is fabricated.

[Captured server audit events](evidence/server-audit.jsonl) corroborate the successful nine-entry call and rejected traversal call. The workspace initializer was rerun and all existing sample-file hashes remained unchanged. The listener was checked as `127.0.0.1:3000`, then the temporary verification server was stopped.

The development execution sandbox denied Node `realpath` despite readable workspace files. Canonical-path operations and tests were executed with authorized elevated shell access. An ordinary user PowerShell terminal needs filesystem permissions to the project and sibling workspace; it should not require removing security checks.

Final build/test/format results are recorded in [verification.txt](evidence/verification.txt). Dependency installation reported zero known vulnerabilities at installation time; this is a point-in-time package audit, not a security certification.
