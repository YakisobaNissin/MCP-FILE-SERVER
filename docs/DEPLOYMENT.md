# M3 deployment

Endpoint: https://smitten-darkish-many.ngrok-free.dev/mcp

The Windows server binds only to 127.0.0.1:3000. PM2 runs one fork with restart enabled and watch disabled; no reboot startup/service was installed. ngrok forwards HTTPS to loopback with inspection disabled. M4/M5 are untouched.

The 256-bit MCP token is stored at `C:\MCPAssignment\.mcp-secrets\mcp-token`, outside Git and the managed workspace. Its Windows ACL admits only the current account and SYSTEM. `.env` contains the file path, not the credential. Authentication runs before JSON parsing, schema validation and all routes; missing/wrong/malformed/duplicate credentials return 401. The approved public hostname is explicitly allowed; Host/Origin and sandbox checks remain active.

```powershell
Set-Location C:\MCPAssignment\mcp-file-server
npm ci
npm run build
npm run pm2:start
npm run verify:deployment -- http://127.0.0.1:3000/mcp
# Only after local verification succeeds:
ngrok http http://127.0.0.1:3000 --url https://smitten-darkish-many.ngrok-free.dev --inspect=false
```

In a second terminal: `npm run verify:deployment -- https://smitten-darkish-many.ngrok-free.dev/mcp`. `npm run pm2:status`, `pm2:restart`, and `pm2:stop` manage the server. Stop a foreground tunnel with Ctrl+C. The tunnel started during verification is hidden; its PID is in ignored `logs/ngrok.pid`. Confirm that PID still belongs to ngrok and this domain before stopping it. No startup-after-reboot registration exists.

Inspector credentials are in ACL-protected `C:\MCPAssignment\.mcp-secrets\inspector.json`. Do not print/copy this file into Git. Verify discovery without placing credentials in command-line arguments:

```powershell
npx --yes @modelcontextprotocol/inspector@2.10.1 --cli --config C:\MCPAssignment\.mcp-secrets\inspector.json --server secure-files --protocol-era modern --method tools/list
```

Token rotation is manual: stop the tunnel/server, generate a new 32-byte CSPRNG token into the private file without printing it, refresh the private Inspector config, restart and reverify before exposure. Another operator must provision their own private token/config and ngrok account; `.env.example` is only a template.

PM2 7.0.4 is pinned as a deployment dependency. Scoped overrides apply patched js-yaml 4.3.2 and basic-ftp 6.2.3. npm still reports three high-severity records from the single unpatched braces advisory through PM2/chokidar. Watch is disabled and no MCP arguments become PM2 glob patterns. Keep PM2 configuration trusted and update when a patch is available; no forced downgrade or audit suppression was used. See [advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).

Verification uses Inspector CLI and the official SDK over the actual HTTPS tunnel. Inspector GUI and Codex integration are not claimed. Account login, token rotation and any later reboot startup require operator setup; ngrok may be interrupted by sleep, logout, account limits or network changes. Existing local-writer race limitations still apply.
