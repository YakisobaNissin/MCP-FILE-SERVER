# Secure MCP File Server

## Purpose

Fourteen MCP tools provide sandboxed file operations, search, read-only Git review, and persistent handoffs using PROJECT_STATE, PLAN_LOG, CHECKPOINTS, and DECISIONS. Paths stay inside a separate workspace; writes and deletion have safety checks, and tool calls are audited without file contents.

## Tech stack

Node.js 24, TypeScript, the official MCP SDK, Zod, Express, Streamable HTTP, oidc-provider for OAuth, ngrok, and PM2. Tool registration uses `McpServer`, `registerTool`, and Zod schemas, as shown in the [official MCP tutorial](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server). This project uses HTTP rather than the tutorial's local stdio transport.

## Requirements

- Windows, Node.js 24.x with npm, and Git on PATH.
- ngrok installed with its account authtoken configured and a reserved domain.
- A workspace separate from this repository and private bearer-token and OAuth-key storage outside both directories.
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

Set `OAUTH_ENABLED=true` in `.env`. After setup and a successful build, start the MCP server and ngrok together from PowerShell:

```powershell
.\start-demo.ps1
```

The script starts the server with PM2, checks that its local endpoint responds, then runs ngrok in the same window. Press `Ctrl+C` there to stop ngrok and the PM2 server together. It reads `PORT` and `PUBLIC_HOST` from `.env`. Before sharing the URL, verify missing/wrong credentials are rejected and authenticated Inspector tool calls succeed. Use `npm run pm2:status` to inspect the server and `npm run pm2:restart` to restart it; reboot startup is not configured.

The MCP URL is `https://<PUBLIC_HOST>/mcp`. The server binds only to `127.0.0.1`.

In Claude Web, add that URL as a custom connector and keep the defaults: **Sign in now**, **Use Claude's published identity**, and **Streamable HTTP**. CIMD resolves Claude's identity from its public HTTPS metadata; **Register automatically** remains available as a fallback. On your own ngrok domain's authorization page, enter the private MCP token without `Bearer ` and approve access. No Claude password or separate OAuth client secret is needed. Choose **Inspect** (read/search/Git), **Plan/report** (also write `.md`, `.txt`, or `.json` documents under `WORKFLOWS/`, update `PROJECT_STATE.md`, and record handoffs), or **Edit** (all fourteen tools). Permissions belong to credentials, including chats sharing them. The private bearer token retains full editor access. Old OAuth grants require reauthorization with the new workspace scopes; grants expire on restart or after eight hours.

For ChatGPT Web, obtain the exact metadata URL and redirect URI shown by its custom MCP setup. Copy `oauth-clients.example.json` outside the workspace, add a `ChatGPT Web` entry with those exact URLs, and set `OAUTH_CLIENTS_FILE` to its absolute path in `.env`. Keep the Claude entry to support both. Only configured HTTPS identities/callbacks on `claude.ai` and `chatgpt.com` are trusted; there are no wildcard callbacks. Public-client CIMD (`none`, including explicitly advertised transition alternatives) and dynamic registration with supported authentication methods are handled; unsupported metadata is rejected. Complete each client's sign-in after activation; ChatGPT connectivity is not established merely by configuring the server.

`create_directory`, `edit_file`, `move_file`, and `restore_file` extend the original tools. Edits require current hashes, moves never overwrite, and restoration needs the deletion recovery ID plus confirmation. Development dotfiles are limited to `.gitignore`, `.editorconfig`, and `.prettierrc.json`; other hidden/credential paths remain protected. `init:workspace` adds `WORKFLOWS/README.md` with short planning, implementation, review/QA, and documentation instructions. Commands, builds, package installation, Git writes, and executed QA remain manual.

## Move to another Windows PC

Move the source repository and managed workspace as two separate folders. Use a Git clone for the source when its current changes have been committed and pushed; otherwise transfer the complete working folder so uncommitted changes are included. Copy the workspace separately, including its project files and Git metadata if its Git history is needed. Do not put `.env` or private credential files in GitHub or in the workspace.

On the new PC, install Node.js 24, Git, and ngrok, then install the project dependencies and build from the repository folder:

```powershell
npm ci
npm run build
```

Recreate the private credential directory on that PC and securely transfer `mcp-token`, `oauth-keys.json`, and `oauth-clients.json` into it. Reapply Windows permissions so only your account and SYSTEM can read them. Transfer `.env` separately and update `WORKSPACE_ROOT`, `MCP_TOKEN_FILE`, `OAUTH_KEY_FILE`, and `OAUTH_CLIENTS_FILE` to the new absolute paths. Keep `PUBLIC_HOST` set to your reserved ngrok domain and configure the ngrok account on the new PC with `ngrok config add-authtoken <token-from-your-ngrok-account>`. If you choose a different domain, update `PUBLIC_HOST` and change the server URL in each web connector.

Run `npm run init:oauth` to validate the copied OAuth key and settings, then start with `.\start-demo.ps1` from PowerShell. The server keeps OAuth grants in memory, so sign in to Claude and ChatGPT again after moving. Use the same ngrok domain and only run one copy of the server at a time. If the old PC is unavailable or you do not want to transfer its credentials, provision a new private bearer token and OAuth signing key on the new PC, update `.env`, and reconnect both clients with the new token.

The current Git working tree has local changes. A clone from GitHub will not include them until you commit and push; transfer the working folder or publish those changes before cloning.
