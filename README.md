# Secure MCP File Server — M2

Six workspace tools over Streamable HTTP at `http://127.0.0.1:3000/mcp`. Node 24, TypeScript, official MCP SDK v2, Zod, and Vitest. The source repository and managed workspace remain separate.

```powershell
Set-Location C:\MCPAssignment\mcp-file-server
npm ci
npm run init:workspace
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
npm run build
npm start
```

`.env` requires an existing absolute `WORKSPACE_ROOT`; `PORT` defaults to 3000. The initializer preserves existing sibling demo files. Stop with Ctrl+C. Use `npm run dev` for source development.

In another terminal, open Inspector:

```powershell
npx --yes @modelcontextprotocol/inspector@2.10.1 --server-url http://127.0.0.1:3000/mcp --transport http
```

Connect using Streamable HTTP, list tools, then use the [six example inputs](docs/TOOLS.md). Create a disposable file, read its hash, replace once, search, and confirm deletion. Deletion is recoverable; it never recursively removes directories.

```powershell
npm run build
npm run typecheck
npm test
npm run format:check
```

Local only: authentication is deferred to M3. Do not tunnel this endpoint. [Security limits](docs/SECURITY.md), [testing](docs/TESTING.md), [architecture](docs/ARCHITECTURE.md), [status](docs/MILESTONES.md).

M1 baseline commit: `8242a4a`. M2 changes are left for review; nothing was pushed. M3–M5 and Codex integration are not implemented.
