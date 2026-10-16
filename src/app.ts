import {
  createMcpExpressApp,
  hostHeaderValidation,
  originValidation,
} from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import express, { type ErrorRequestHandler } from "express";
import type { Sandbox } from "./security/sandbox.js";
import { createServer } from "./tools/index.js";
import { stderrAudit, type AuditSink } from "./logging/audit.js";
import { toolSchemas, type ToolName } from "./tools/schemas.js";
import { bearerAuthentication } from "./security/auth.js";
import { createOAuth, type OAuthSettings } from "./security/oauth.js";
import {
  authorizeTool,
  requestAccess,
  workspaceScopes,
} from "./security/permissions.js";
import { publicError } from "./security/errors.js";

export function createApp(
  sandbox: Sandbox,
  options: {
    bearerToken: string;
    publicHost?: string | undefined;
    oauth?: OAuthSettings | undefined;
  },
  audit: AuditSink = stderrAudit,
) {
  const app = express();
  app.disable("x-powered-by");
  const hosts = [
    "localhost",
    "127.0.0.1",
    "[::1]",
    ...(options.publicHost ? [options.publicHost] : []),
  ];
  const oauth = options.oauth
    ? createOAuth(options.oauth, options.bearerToken)
    : undefined;
  if (oauth) {
    const publicGuards = [hostHeaderValidation(hosts), originValidation(hosts)];
    app.get(
      [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
      ],
      ...publicGuards,
      (_req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.json({
          resource: oauth.resource,
          authorization_servers: [oauth.issuer],
          scopes_supported: workspaceScopes,
          bearer_methods_supported: ["header"],
        });
      },
    );
    app.get(
      "/.well-known/oauth-authorization-server/oauth",
      ...publicGuards,
      (_req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.json(oauth.metadata);
      },
    );
    app.use("/oauth", ...publicGuards, oauth.router);
  }
  app.use(bearerAuthentication(options.bearerToken, oauth));
  const mcpApp = createMcpExpressApp({
    host: "127.0.0.1",
    allowedHosts: hosts,
    allowedOrigins: hosts,
    jsonLimit: "256kb",
  });
  mcpApp.disable("x-powered-by");
  app.use(mcpApp);
  const handler = createMcpHandler(() =>
    createServer(sandbox, audit, requestAccess.getStore() ?? "inspect"),
  );
  const nodeHandler = toNodeHandler(handler);
  mcpApp.all("/mcp", (req, res, next) => {
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
        const profile = requestAccess.getStore() ?? "inspect";
        try {
          authorizeTool(profile, tool, args);
        } catch (error) {
          const safe = publicError(error);
          audit({
            time: new Date().toISOString(),
            tool,
            profile,
            outcome: "error",
            duration_ms: 0,
            error_code: safe.code,
          });
          res.json({
            jsonrpc: "2.0",
            id: "id" in body ? body.id : null,
            result: {
              isError: true,
              content: [
                { type: "text", text: JSON.stringify({ error: safe }) },
              ],
            },
          });
          return;
        }
        if (!toolSchemas[tool].safeParse(args).success) {
          audit({
            time: new Date().toISOString(),
            tool,
            profile,
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
