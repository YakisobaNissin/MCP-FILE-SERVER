import { createApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { publicError } from "./security/errors.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const { app, close } = createApp(config.sandbox, {
    bearerToken: config.bearerToken,
    publicHost: config.publicHost,
  });
  const listener = app.listen(config.port, config.host, () => {
    console.error(
      `M3 authenticated MCP endpoint: http://${config.host}:${config.port}/mcp (loopback)`,
    );
  });
  listener.on("error", () => {
    console.error(
      "Startup failed: unable to bind the local port. Check PORT and other running processes.",
    );
    process.exitCode = 1;
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    listener.close();
    void close().finally(() => {
      listener.closeAllConnections();
      if (process.connected) process.disconnect();
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("message", (message: unknown) => {
    if (message === "shutdown") shutdown();
  });
}

main().catch((error: unknown) => {
  console.error(`Startup failed: ${publicError(error).message}`);
  process.exitCode = 1;
});
