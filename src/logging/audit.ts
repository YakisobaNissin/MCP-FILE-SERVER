import type { ToolName } from "../tools/schemas.js";
import type { AccessProfile } from "../security/permissions.js";

export interface AuditEvent {
  time: string;
  tool: ToolName;
  outcome: "success" | "partial" | "error";
  duration_ms: number;
  returned?: number;
  error_code?: string;
  profile?: AccessProfile;
}

export type AuditSink = (event: AuditEvent) => void;

// stderr can be redirected to a private JSONL file; never log paths, arguments,
// file contents, raw errors, headers, or credentials.
export const stderrAudit: AuditSink = (event) => {
  process.stderr.write(`${JSON.stringify(event)}\n`);
};
