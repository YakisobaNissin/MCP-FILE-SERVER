# Secure MCP File Server — M3

Six workspace tools over authenticated Streamable HTTP. Node 24, TypeScript, official MCP SDK v2, Zod, and Vitest. The source repository and managed workspace remain separate. [M3 deployment and verification](docs/DEPLOYMENT.md).

```powershell
Set-Location C:\MCPAssignment\mcp-file-server
npm ci
npm run init:workspace
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
npm run build
npm start
```

`.env` requires an existing absolute `WORKSPACE_ROOT` and a private `MCP_TOKEN_FILE` outside the source/workspace; `PORT` defaults to 3000. Provision the private token before startup. The initializer preserves existing sibling demo files. Stop with Ctrl+C. Use `npm run dev` for source development.

In another terminal, open Inspector:

```powershell
npx --yes @modelcontextprotocol/inspector@2.10.1 --cli --config C:\MCPAssignment\.mcp-secrets\inspector.json --server secure-files --method tools/list
```

Connect using Streamable HTTP, list tools, then use the [six example inputs](docs/TOOLS.md). Create a disposable file, read its hash, replace once, search, and confirm deletion. Deletion is recoverable; it never recursively removes directories.

```powershell
npm run build
npm run typecheck
npm test
npm run format:check
```

The listener stays loopback; ngrok exposes only the authenticated endpoint. [Security limits](docs/SECURITY.md), [testing](docs/TESTING.md), [architecture](docs/ARCHITECTURE.md), [status](docs/MILESTONES.md).

M1 baseline: `8242a4a`; M2: `fe86588`. M3 changes remain for review; nothing was pushed. M4/M5 and Codex integration are not implemented.
