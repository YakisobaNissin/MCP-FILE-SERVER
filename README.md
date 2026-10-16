# Secure MCP File Server

## Purpose

Ten MCP tools provide sandboxed file operations, search, read-only Git review, and persistent handoffs using PROJECT_STATE, PLAN_LOG, CHECKPOINTS, and DECISIONS. Paths stay inside a separate workspace; writes and deletion have safety checks, and tool calls are audited without file contents.

## Tech stack

Node.js 24, TypeScript, the official MCP SDK, Zod, Express, Streamable HTTP, oidc-provider for OAuth, ngrok, and PM2. Tool registration uses `McpServer`, `registerTool`, and Zod schemas, as shown in the [official MCP tutorial](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server). This project uses HTTP rather than the tutorial's local stdio transport.

## Requirements

- Windows, Node.js 24.x with npm, and Git on PATH.
- ngrok installed with its account authtoken configured and a reserved domain.
- A workspace separate from this repository and private bearer-token storage outside both directories.
- An MCP client supporting Streamable HTTP and OAuth or an `Authorization: Bearer` header.

## Setup

From the repository directory:

```powershell
npm ci
npm run init:workspace
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
```

Edit `.env`: set `WORKSPACE_ROOT`, `MCP_TOKEN_FILE`, `PORT`, and `PUBLIC_HOST`. The initializer creates the sibling `demo-workspace` and preserves existing files. Provision a cryptographically random 32-byte base64url token in the private file; restrict its Windows permissions and its parent directory to your account and SYSTEM. Never commit or print credentials. Existing local token storage can be reused. Set `OAUTH_KEY_FILE` in that same private directory. The public hostname must match your ngrok domain. Git tools require a workspace Git repository prepared by you; they never initialize or stage files.

```powershell
npm run build
npm run init:oauth
```

Set `OAUTH_ENABLED=true` in `.env`, then start the server:

```powershell
npm run pm2:start
```

Before opening the tunnel, manually verify that missing/wrong credentials are rejected on `http://127.0.0.1:3000/mcp` and authenticated Inspector tool calls succeed. Then run one tunnel, using your configured domain:

```powershell
ngrok http http://127.0.0.1:3000 --url https://smitten-darkish-many.ngrok-free.dev --inspect=false
```

The MCP URL is `https://smitten-darkish-many.ngrok-free.dev/mcp`. The server binds only to `127.0.0.1`. Stop the tunnel with Ctrl+C, then run `npm run pm2:stop`. Use `npm run pm2:status` to inspect the server and `npm run pm2:restart` to restart it; reboot startup is not configured.

In Claude Web, add that URL as a custom connector and keep the defaults: **Sign in now**, **Use Claude's published identity**, and **Streamable HTTP**. CIMD resolves Claude's identity from its public HTTPS metadata; **Register automatically** remains available as a fallback. On your own ngrok domain's authorization page, enter the private MCP token without `Bearer ` and approve access. No Claude password or separate OAuth client secret is needed. This single-owner setup grants all ten tools. OAuth grants are held in memory: reconnect Claude after a server restart or when the eight-hour grant expires. Workspace files persist; this setup is not a multi-user identity service.
