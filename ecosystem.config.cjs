const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "secure-mcp-file-server",
      cwd: __dirname,
      script: "dist/server.js",
      interpreter: process.execPath,
      node_args: "--env-file=.env",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      restart_delay: 1000,
      max_restarts: 5,
      min_uptime: "5s",
      shutdown_with_message: true,
      kill_timeout: 5000,
      out_file: path.join(__dirname, "logs/mcp-out.log"),
      error_file: path.join(__dirname, "logs/mcp-error.log"),
      env: { NODE_ENV: "production" },
    },
  ],
};
