export interface AuditEvent {
  time: string;
  tool: "list_files";
  outcome: "success" | "error";
  duration_ms: number;
  returned?: number;
  error_code?: string;
}

export type AuditSink = (event: AuditEvent) => void;

// stderr can be redirected to a private JSONL file; never log paths, arguments,
// file contents, raw errors, headers, or credentials.
export const stderrAudit: AuditSink = (event) => {
  process.stderr.write(`${JSON.stringify(event)}\n`);
};
