# Decisions

- Retain Node 24, TypeScript, official SDK v2 server/client 2.3.1, Express adapter 2.0.2 and Node adapter 2.1.1; no dependencies added in M2. M3 adds only PM2 for required process management, with narrow security overrides described in DEPLOYMENT.md.
- Preserve M1 as commit `8242a4a` before implementation.
- Require read hashes for edits/deletes and confirmation for recoverable deletion. Keep creation exclusive; use bounded UTF-8 text operations rather than general binary-file management.
- Share sandbox/scanning/auditing and serialize mutations within the running server. Ordinary Node APIs still require trusted local filesystem writers.
- Raise only the HTTP JSON body cap to 256 KiB for escaped text arguments; keep Streamable HTTP integration and loopback binding.

Original SDK integration reference: [official Express recipe](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/express.md).
