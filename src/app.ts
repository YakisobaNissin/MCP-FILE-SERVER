import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { ErrorRequestHandler } from "express";
import type { Sandbox } from "./security/sandbox.js";
import { createServer } from "./tools/index.js";
import { stderrAudit, type AuditSink } from "./logging/audit.js";
import { toolSchemas, type ToolName } from "./tools/schemas.js";

export function createApp(sandbox: Sandbox, audit: AuditSink = stderrAudit) {
  const app = createMcpExpressApp({ host: "127.0.0.1", jsonLimit: "256kb" });
  app.disable("x-powered-by");
  const handler = createMcpHandler(() => createServer(sandbox, audit));
  const nodeHandler = toNodeHandler(handler);
  app.all("/mcp", (req, res, next) => {
    // SDK schema rejection happens before the tool callback; audit it here
    // without recording untrusted argument values.
    const body: unknown = req.body;
    if (
      typeof body === "object" &&
      body !== null &&
      "method" in body &&
      body.method === "tools/call" &&
      "params" in body
    ) {
      const params = body.params;
      if (
        typeof params === "object" &&
        params !== null &&
        "name" in params &&
        typeof params.name === "string" &&
        Object.hasOwn(toolSchemas, params.name)
      ) {
        const args = "arguments" in params ? params.arguments : {};
        const tool = params.name as ToolName;
        if (!toolSchemas[tool].safeParse(args).success) {
          audit({
            time: new Date().toISOString(),
            tool,
            outcome: "error",
            duration_ms: 0,
            error_code: "INVALID_INPUT",
          });
        }
      }
    }
    void nodeHandler(req, res, req.body).catch(next);
  });
  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    _req,
    res,
    _next,
  ) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = (error as { status?: number } | null)?.status;
    const safeStatus = status === 413 ? 413 : status === 400 ? 400 : 500;
    res.status(safeStatus).json({
      error:
        safeStatus === 413
          ? "Request body too large."
          : safeStatus === 400
            ? "Invalid JSON request."
            : "Request failed.",
    });
  };
  app.use(errorHandler);
  return { app, close: () => handler.close() };
}
