const path = require("path");
const fs = require("fs");
const { app, Tray, Menu, BrowserWindow, ipcMain, Notification, nativeImage } = require("electron");
const { EventSource } = require("eventsource");
const { startWalletServer } = require("../wallet/server");

const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:14000";
const WALLET_PORT = Number(process.env.WALLET_PORT || 17000);
const WALLET_URL = process.env.WALLET_URL || `http://localhost:${WALLET_PORT}`;
app.setName("MiID");
const walletSignSecret = cryptoRandomSecret();
const DEBUG_AUTH = process.env.DEBUG_AUTH === "1";
const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
}

function dlog(message) {
  if (DEBUG_AUTH) {
    console.log(`[menubar] ${message}`);
  }
}

let tray = null;
let win = null;
let walletServer = null;
let eventSource = null;
let walletDid = process.env.WALLET_DID || null;
let didSyncTimer = null;

function cryptoRandomSecret() {
  return require("crypto").randomBytes(24).toString("hex");
}

function loadDidFromWalletData() {
  try {
    const walletPath = path.join(__dirname, "..", "..", "data", "wallet.json");
    if (!fs.existsSync(walletPath)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(walletPath, "utf8"));
    return parsed.wallets && parsed.wallets[0] ? parsed.wallets[0].did : null;
  } catch (_err) {
    return null;
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `http_${res.status}`);
  }
  return body;
}

async function getChallenges() {
  if (!walletDid) {
    return [];
  }
  const data = await fetchJson(`${GATEWAY_URL}/v1/wallet/challenges?did=${encodeURIComponent(walletDid)}`);
  return data.challenges || [];
}

async function getSessions() {
  if (!walletDid) {
    return [];
  }
  const data = await fetchJson(`${GATEWAY_URL}/v1/wallet/sessions?did=${encodeURIComponent(walletDid)}`);
  return data.sessions || [];
}

async function getApproved() {
  if (!walletDid) {
    return [];
  }
  const data = await fetchJson(`${GATEWAY_URL}/v1/wallet/approved?did=${encodeURIComponent(walletDid)}`);
  return data.approved || [];
}

function openWindow() {
  if (!win) {
    win = new BrowserWindow({
      width: 420,
      height: 560,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js")
      }
    });
    win.loadFile(path.join(__dirname, "ui", "index.html"));
    win.on("close", (e) => {
      if (!app.isQuiting) {
        e.preventDefault();
        win.hide();
      }
    });
  }
  win.show();
  win.focus();
  dlog("window opened");
}

async function ensureWalletDid() {
  if (walletDid) {
    dlog(`using did from memory did=${walletDid}`);
    return walletDid;
  }
  walletDid = loadDidFromWalletData();
  if (walletDid) {
    dlog(`using did from wallet store did=${walletDid}`);
    return walletDid;
  }
  try {
    const created = await fetchJson(`${WALLET_URL}/v1/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "desktop-user" })
    });
    walletDid = created.did;
    dlog(`created did=${walletDid}`);
    return walletDid;
  } catch (err) {
    dlog(`ensure did failed: ${err.message}`);
    return null;
  }
}

function showApproveNotification(serviceId, scopes) {
  dlog(`notification service=${serviceId} scopes=${(scopes || []).join(",")}`);
  const n = new Notification({
    title: "MiID 승인 요청",
    body: `${serviceId}가 ${scopes.join(", ")} 요청`
  });
  n.on("click", () => openWindow());
  n.show();
}

function connectEventStream() {
  if (!walletDid) {
    return;
  }
  if (eventSource) {
    eventSource.close();
  }
  dlog(`connect wallet event stream did=${walletDid}`);
  eventSource = new EventSource(`${GATEWAY_URL}/v1/wallet/events?did=${encodeURIComponent(walletDid)}`);
  const forward = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "challenge_created") {
        dlog(`event challenge_created service=${data.payload.service_id}`);
        showApproveNotification(data.payload.service_id, data.payload.scopes || []);
      }
      if (win && !win.isDestroyed()) {
        win.webContents.send("challenge:event", data);
      }
    } catch (_err) {
      // ignore bad event payload
    }
  };
  eventSource.addEventListener("challenge_created", forward);
  eventSource.addEventListener("challenge_approved", forward);
  eventSource.addEventListener("challenge_denied", forward);
  eventSource.addEventListener("session_created", forward);
  eventSource.addEventListener("session_revoked", forward);
  eventSource.addEventListener("approved_cancelled", forward);
  eventSource.onerror = () => {
    dlog("wallet event stream error (auto-retry)");
    // EventSource handles retry internally.
  };
}

function refreshTrayMenu() {
  if (!tray) {
    return;
  }
  const menu = Menu.buildFromTemplate([
    { label: "Open Approvals", click: () => openWindow() },
    { type: "separator" },
    {
      label: walletDid ? `DID: ${walletDid}` : "DID: not found",
      enabled: false
    },
    {
      label: "Quit",
      click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
}

function broadcastDidChanged() {
  if (win && !win.isDestroyed()) {
    win.webContents.send("challenge:event", { type: "did_changed", payload: { did: walletDid } });
  }
}

function syncDidFromStore() {
  const fromStore = loadDidFromWalletData();
  if (!fromStore || fromStore === walletDid) {
    return;
  }
  walletDid = fromStore;
  refreshTrayMenu();
  connectEventStream();
  broadcastDidChanged();
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("MiID");
  tray.setToolTip("MiID Wallet Approvals");
  tray.on("click", () => openWindow());
  refreshTrayMenu();
}

ipcMain.handle("context:get", async () => {
  dlog(`context requested did=${walletDid || "none"}`);
  return { did: walletDid, gatewayUrl: GATEWAY_URL, walletUrl: WALLET_URL };
});

ipcMain.handle("challenges:list", async () => {
  const list = await getChallenges();
  dlog(`pending list count=${list.length}`);
  return { challenges: list };
});

ipcMain.handle("sessions:list", async () => {
  const sessions = await getSessions();
  dlog(`sessions list count=${sessions.length}`);
  return { sessions };
});

ipcMain.handle("approved:list", async () => {
  const approved = await getApproved();
  dlog(`approved list count=${approved.length}`);
  return { approved };
});

ipcMain.handle("approved:cancel", async (_event, authorizationCode) => {
  dlog(`approved cancel code=${authorizationCode}`);
  return fetchJson(`${GATEWAY_URL}/v1/wallet/approved/${encodeURIComponent(authorizationCode)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: walletDid })
  });
});

ipcMain.handle("session:revoke", async (_event, sessionId) => {
  dlog(`session revoke id=${sessionId}`);
  return fetchJson(`${GATEWAY_URL}/v1/wallet/sessions/${sessionId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: walletDid })
  });
});

ipcMain.handle("challenge:approve", async (_event, challengeId) => {
  dlog(`approve requested challenge=${challengeId}`);
  const challengeStatus = await fetchJson(`${GATEWAY_URL}/v1/auth/challenges/${challengeId}/status`);
  if (challengeStatus.status !== "pending") {
    throw new Error(`challenge_not_pending:${challengeStatus.status}`);
  }
  const pending = await getChallenges();
  const current = pending.find((c) => c.challenge_id === challengeId);
  if (!current) {
    throw new Error("challenge_not_found_in_pending");
  }

  const sign = await fetchJson(`${WALLET_URL}/v1/wallets/sign`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wallet-sign-secret": walletSignSecret
    },
    body: JSON.stringify({
      did: walletDid,
      challenge_id: challengeId,
      nonce: current.nonce,
      audience: current.client_id,
      expires_at: current.expires_at
    })
  });
  dlog(`approve click challenge=${challengeId} signed`);

  return fetchJson(`${GATEWAY_URL}/v1/wallet/challenges/${challengeId}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: walletDid, wallet_url: WALLET_URL, signature: sign.signature })
  });
});

ipcMain.handle("challenge:deny", async (_event, challengeId) => {
  dlog(`deny requested challenge=${challengeId}`);
  return fetchJson(`${GATEWAY_URL}/v1/wallet/challenges/${challengeId}/deny`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: walletDid })
  });
});

app.whenReady().then(async () => {
  process.env.WALLET_SIGN_SECRET = walletSignSecret;
  walletServer = startWalletServer({ port: WALLET_PORT });
  await ensureWalletDid();
  dlog(`app ready did=${walletDid || "none"} gateway=${GATEWAY_URL}`);
  createTray();
  connectEventStream();
  didSyncTimer = setInterval(syncDidFromStore, 3000);
});

app.on("second-instance", () => {
  dlog("second instance attempted; focusing existing window");
  openWindow();
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
});

app.on("before-quit", () => {
  if (didSyncTimer) {
    clearInterval(didSyncTimer);
  }
  if (eventSource) {
    eventSource.close();
  }
  if (walletServer) {
    walletServer.close();
  }
});
