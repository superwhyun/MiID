const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const electronBin = path.join(root, "node_modules", ".bin", "electron");
const gatewayDir = path.join(root, "apps", "gateway");
const menubarDir = path.join(root, "apps", "menubar");
const walletDir = path.join(root, "apps", "wallet");

let gatewayProc = null;
let menubarProc = null;
let stopping = false;
let restartingMenubar = false;

function cleanupStaleMenubar() {
  try {
    execSync("pkill -f 'apps/menubar/main.js'", { stdio: "ignore" });
  } catch (_err) {
    // ignore
  }
}

function run(name, cmd, args) {
  const child = spawn(cmd, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit"
  });
  child.on("exit", (code, signal) => {
    if (stopping) {
      return;
    }
    if (code !== null) {
      console.log(`[hot] ${name} exited with code ${code}`);
    } else {
      console.log(`[hot] ${name} exited with signal ${signal}`);
    }
  });
  return child;
}

function startGateway() {
  if (gatewayProc) {
    return;
  }
  gatewayProc = run("gateway", "node", ["apps/gateway/server.js"]);
}

function startMenubar() {
  if (menubarProc) {
    return;
  }
  menubarProc = run("menubar", electronBin, ["apps/menubar/main.js"]);
}

function restartGateway() {
  if (!gatewayProc) {
    startGateway();
    return;
  }
  const old = gatewayProc;
  gatewayProc = null;
  old.once("exit", () => startGateway());
  old.kill("SIGTERM");
}

function restartMenubar() {
  if (restartingMenubar) {
    return;
  }
  restartingMenubar = true;
  if (!menubarProc) {
    startMenubar();
    restartingMenubar = false;
    return;
  }
  const old = menubarProc;
  menubarProc = null;
  old.once("exit", () => {
    startMenubar();
    restartingMenubar = false;
  });
  old.kill("SIGTERM");
}

function watchDir(dir, onChange) {
  let timer = null;
  const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename) {
      return;
    }
    if (filename.includes("node_modules")) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => onChange(filename), 150);
  });
  return watcher;
}

const gatewayWatcher = watchDir(gatewayDir, (file) => {
  console.log(`[hot] gateway changed: ${file}`);
  restartGateway();
});

const menubarWatcher = watchDir(menubarDir, (file) => {
  console.log(`[hot] menubar changed: ${file}`);
  restartMenubar();
});

const walletWatcher = watchDir(walletDir, (file) => {
  console.log(`[hot] wallet changed: ${file}`);
  restartMenubar();
});

function shutdown(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log(`\n[hot] received ${signal}, shutting down...`);
  gatewayWatcher.close();
  menubarWatcher.close();
  walletWatcher.close();
  if (gatewayProc) gatewayProc.kill("SIGTERM");
  if (menubarProc) menubarProc.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startGateway();
cleanupStaleMenubar();
startMenubar();
