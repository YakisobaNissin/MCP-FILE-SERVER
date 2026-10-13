# M1 development decisions

1. **Use stable SDK v2.** On 2026-10-13 the npm registry confirmed `@modelcontextprotocol/server`/`client` 2.3.1, Express adapter 2.0.2 and Node adapter 2.1.1. These packages replace v1's combined SDK. Exact SDK versions and a lockfile make this milestone reproducible.
2. **Use the official Express recipe.** `createMcpExpressApp`, `createMcpHandler`, and `toNodeHandler` separate framework concerns from MCP protocol handling. This keeps our own code focused on file access. Express is a direct dependency of our application's transport layer; Zod supplies strict schemas.
3. **Use Node 24's environment-file support.** No dotenv dependency is necessary. TypeScript strict checking, Vitest, and Prettier cover development needs. No containers, orchestration services, or database are introduced.
4. **Keep M1 read-only and local.** Authentication, HTTPS tunneling and process management are scheduled for M3. Their absence is a reason to prohibit public hosting now.
5. **Disallow all links and hidden entries initially.** This is more restrictive than permitting internal symlinks, but easier to explain and test. Shared validation and canonical checks also protect discovery results. Policy can be deliberately refined later.
6. **Use fixed budgets and explicit incompleteness flags.** Listing never dumps the entire workspace. Narrow paths and offsets encourage purposeful agent calls.
7. **Preserve operator files.** Demo initialization creates a separate sibling and writes with `wx`; reruns do not overwrite existing files. Git source initialization is local, with no remote, push or commit performed.

Official references consulted before dependency installation:

- [SDK v2 documentation](https://ts.sdk.modelcontextprotocol.io/v2/)
- [Official Express integration](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/express.md)
- [Official HTTP serving model](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)
- [MCP Inspector documentation](https://modelcontextprotocol.io/docs/tools/inspector)

Installed declaration files were checked against the implementation, then the build and real protocol tests verified the chosen APIs.
