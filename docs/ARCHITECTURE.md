# Architecture

MCP client → loopback Express /mcp → official SDK protocol/schema validation → tool wrapper/audit → filesystem services → shared sandbox → separate workspace.

The transport remains stateless and uses the existing SDK v2 packages. A single Sandbox is shared by per-request server instances so mutation serialization spans requests. Listing and search share the bounded scanner; file operations share descriptor reads, hashing, staging and security limits. MCP errors are sanitized centrally.

Creates publish staged files exclusively; replacements use hash/version rechecks and rename; deletion moves to private recovery storage. There is no LLM, orchestration engine, database, Git tool or handoff service in M2.
