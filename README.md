# Secure MCP File Server — M1

A university assignment connector that exposes a sandboxed filesystem to an MCP host. **M1 is implemented:** one read-only `list_files` tool over Streamable HTTP at `http://127.0.0.1:3000/mcp`. The server contains no LLM or agent runtime.

This milestone has no file mutations, Git tools, remote authentication, public tunnel, PM2 deployment, or multi-session demonstration. Those belong to later approved milestones. Do not forward or tunnel this unauthenticated local endpoint.

## Prerequisites

- Windows and PowerShell.
- Node.js **24 LTS**, npm, and Git. `package.json` intentionally targets Node 24.
- A separate, trusted managed folder. Do not select a home directory, source repository, or folder containing private data.

Development was verified with Node 24.19.0, npm 11.17.0 and Git 2.53.0.windows.3. Dependencies are locked in `package-lock.json`.

## Install and initialize

For this assignment, open PowerShell and run:

```powershell
Set-Location C:\MCPAssignment\mcp-file-server
npm ci
npm run init:workspace
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
npm run build
npm run typecheck
npm test
npm start
```

Copy `.env.example` only on first setup; preserve an existing `.env`. `init:workspace` safely creates the fixed sibling `../demo-workspace`, uses exclusive file creation, and preserves existing files. It rejects linked directory targets. For a clone in another location, the script creates the sibling there; edit `WORKSPACE_ROOT` in `.env` to match its absolute location. Initialization does not initialize Git in the managed folder.

The repository was initialized with Git but no initial commit was made. Review files before committing. The managed sibling folder is outside this repository and is never included automatically.

The endpoint always binds to `127.0.0.1`. `HOST` is not configurable in M1. Stop with **Ctrl+C** in the server terminal. For source development, use `npm run dev` instead of `npm start`.

## Connect MCP Inspector

Keep the server terminal running. In a second PowerShell terminal:

```powershell
Set-Location C:\MCPAssignment\mcp-file-server
npx --yes @modelcontextprotocol/inspector@2.10.1 --server-url http://127.0.0.1:3000/mcp --transport http
```

Open the loopback URL printed by Inspector (it includes Inspector's own proxy authentication token). If prompted, select **Streamable HTTP**, enter `http://127.0.0.1:3000/mcp`, and connect. List tools, then invoke `list_files`:

```json
{ "path": ".", "recursive": true, "limit": 50, "offset": 0 }
```

Inspector CLI provides a repeatable check without the browser:

```powershell
npx --yes @modelcontextprotocol/inspector@2.10.1 --cli http://127.0.0.1:3000/mcp --transport http --method tools/list
npx --yes @modelcontextprotocol/inspector@2.10.1 --cli http://127.0.0.1:3000/mcp --transport http --method tools/call --tool-name list_files --tool-arg path=. --tool-arg recursive=true --tool-arg limit=50
```

Inspector's proxy token is separate from endpoint authentication; M1 has no endpoint credentials. Keep both tools local. GUI and Codex verification must be recorded separately from CLI or SDK test results.

## Configuration

| Variable         | Meaning                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `WORKSPACE_ROOT` | Required existing absolute directory, canonicalized at startup. Must be disjoint from the source repository. |
| `PORT`           | Integer 1024–65535; default 3000.                                                                            |

Node loads `.env` if present; process environment variables take precedence. Native filesystem errors are sanitized. The process exits on invalid configuration and reports a generic local error if the port is occupied.

## Layout and documentation

```text
src/server.ts         startup and shutdown
src/app.ts            Express /mcp transport and HTTP guards
src/config/           environment and source/workspace separation
src/tools/            strict Zod schema and MCP registration
src/services/         bounded directory listing
src/security/         shared path policy, canonical checks, safe errors
src/logging/          content-free JSONL tool audit
tests/                isolated filesystem and real HTTP MCP tests
scripts/              non-overwriting demo initializer
docs/                 architecture, security, tools and evidence
```

See [architecture](docs/ARCHITECTURE.md), [tool contract](docs/TOOLS.md), [security](docs/SECURITY.md), [testing and evidence](docs/TESTING.md), [milestone status](docs/MILESTONES.md), and [stack decisions](docs/DECISIONS.md).

## Troubleshooting

- Missing workspace: run `npm run init:workspace`, then check `.env`.
- `WORKSPACE_ROOT` rejected: use an absolute existing real directory outside the source repository. Paths containing links or junctions are not usable tool targets.
- Port occupied: stop the earlier server or choose another `PORT`; use the same port in Inspector.
- GET returns 405: legacy stateless clients do not have a standalone GET/SSE session. Use Inspector or the official SDK to initialize and POST requests; this is Streamable HTTP, not an old `/sse` endpoint.
- Listing incomplete: inspect `next_offset` and budget flags; narrow `path` rather than repeatedly scanning the root.
- Windows restricted execution reports `EPERM` on `realpath`: run the commands in a normal terminal with authorized access. Do not remove canonical-path validation to work around execution restrictions.
- Corporate network blocks npm: configure your approved registry/network access. Do not disable TLS validation.

Stop at M1. Implement M2 only after explicit approval.
