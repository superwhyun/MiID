const { spawn } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");

function start(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, {
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

const wallet = start("wallet", "node", ["apps/wallet/server.js"]);
const gateway = start("gateway", "node", ["apps/gateway/server.js"]);

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`\n[dev] received ${signal}, shutting down...`);
  wallet.kill("SIGTERM");
  gateway.kill("SIGTERM");
  setTimeout(() => process.exit(0), 300);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
