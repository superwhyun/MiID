const { spawn, execSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const electronBin = path.join(root, "node_modules", ".bin", "electron");

function cleanupStaleMenubar() {
  try {
    execSync("pkill -f 'apps/menubar/main.js'", { stdio: "ignore" });
  } catch (_err) {
    // no stale process
  }
}

function run(name, command, args) {
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
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

const gateway = run("gateway", "node", ["apps/gateway/server.js"]);
cleanupStaleMenubar();
const menubar = run("menubar", electronBin, ["apps/menubar/main.js"]);

let exiting = false;
function stopAll(signal) {
  if (exiting) {
    return;
  }
  exiting = true;
  console.log(`\n[dev:desktop] received ${signal}, stopping all...`);
  gateway.kill("SIGTERM");
  menubar.kill("SIGTERM");
  setTimeout(() => process.exit(0), 400);
}

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));
