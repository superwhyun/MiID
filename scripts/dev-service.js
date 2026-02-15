const { spawn } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");

function run(name, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit"
  });
  child.on("exit", (code, signal) => {
    if (code !== null) {
      console.log(`[${name}] exited with code ${code}`);
    } else {
      console.log(`[${name}] exited with signal ${signal}`);
    }
  });
  return child;
}

const backendPort = process.env.BACKEND_PORT || "15000";
const frontendPort = process.env.FRONTEND_PORT || "3000";
const backendUrl = process.env.BACKEND_URL || `http://localhost:${backendPort}`;

const backend = run("service-backend", "node", ["apps/service-backend/server.js"], {
  PORT: backendPort
});
const frontend = run("service-frontend", "node", ["apps/service-frontend/server.js"], {
  FRONTEND_PORT: frontendPort,
  BACKEND_URL: backendUrl
});

let exiting = false;
function shutdown(signal) {
  if (exiting) {
    return;
  }
  exiting = true;
  console.log(`\n[service] received ${signal}, shutting down...`);
  backend.kill("SIGTERM");
  frontend.kill("SIGTERM");
  setTimeout(() => process.exit(0), 400);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
