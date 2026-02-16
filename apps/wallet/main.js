const path = require("path");
const fs = require("fs");
const { app, Tray, Menu, BrowserWindow, ipcMain, Notification, nativeImage } = require("electron");
const { EventSource } = require("eventsource");
const { startWalletServer } = require("./server");

function getWalletDataDir() {
  if (process.env.MIID_DATA_DIR) {
    return process.env.MIID_DATA_DIR;
  }
  return path.join(app.getPath("userData"), "data");
}

function loadAppConfig() {
  const candidates = [
    process.env.MIID_CONFIG_PATH,
    path.join(__dirname, "config.json"),
    path.join(__dirname, "..", "..", "config", "wallet.config.json")
  ].filter(Boolean);
  for (const configPath of candidates) {
    try {
      if (!fs.existsSync(configPath)) {
        continue;
      }
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return { config: parsed, configPath };
    } catch (_err) {
      // ignore invalid config and continue fallback
    }
  }
  return { config: {}, configPath: null };
}

function normalizeUrl(url) {
  if (!url || typeof url !== "string") {
    return null;
  }
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

const appConfigLoaded = loadAppConfig();
const appConfig = appConfigLoaded.config;
const configuredGatewayUrl = normalizeUrl(appConfig.gateway_url || appConfig.gatewayUrl);
const GATEWAY_URL = normalizeUrl(process.env.GATEWAY_URL) || configuredGatewayUrl || "http://localhost:14000";
const WALLET_PORT = Number(process.env.WALLET_PORT || appConfig.wallet_port || appConfig.walletPort || 17000);
const WALLET_URL = process.env.WALLET_URL || `http://localhost:${WALLET_PORT}`;
app.setName("MiID");
const walletSignSecret = cryptoRandomSecret();
const DEBUG_AUTH = process.env.DEBUG_AUTH === "1";
const POPUP_ON_CHALLENGE = process.env.MIID_POPUP_ON_CHALLENGE !== "0";
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
    const walletPath = path.join(getWalletDataDir(), "wallet.json");
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

function hasAllScopes(have, need) {
  const set = new Set(have || []);
  return (need || []).every((s) => set.has(s));
}

function parseScope(scopeText) {
  if (!scopeText || typeof scopeText !== "string") {
    return [];
  }
  return scopeText.split(" ").map((s) => s.trim()).filter(Boolean);
}

async function shouldAutoApproveChallenge(serviceId, scopes) {
  const sessions = await getSessions();
  return sessions.some((s) => s.service_id === serviceId && hasAllScopes(parseScope(s.scope), scopes));
}

async function approveChallenge(challengeId) {
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
  dlog(`approve signed challenge=${challengeId}`);

  return fetchJson(`${GATEWAY_URL}/v1/wallet/challenges/${challengeId}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: walletDid, wallet_url: WALLET_URL, signature: sign.signature })
  });
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
  if (POPUP_ON_CHALLENGE) {
    openWindow();
  }
  try {
    const n = new Notification({
      title: "MiID 승인 요청",
      body: `${serviceId}가 ${scopes.join(", ")} 요청`
    });
    n.on("click", () => openWindow());
    n.show();
  } catch (err) {
    dlog(`notification failed: ${err.message}`);
  }
}

function showAutoApprovedNotification(serviceId, scopes) {
  const n = new Notification({
    title: "MiID 자동 승인",
    body: `${serviceId} ${scopes.join(", ")} 자동 승인됨`
  });
  n.on("click", () => openWindow());
  n.show();
}

function showReusedLoginNotification(serviceId, scopes) {
  const n = new Notification({
    title: "MiID 로그인",
    body: `${serviceId} 로그인 재사용 (${scopes.join(", ")})`
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
  const forward = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "challenge_created") {
        const serviceId = data.payload.service_id;
        const scopes = data.payload.scopes || [];
        const challengeId = data.payload.challenge_id;
        dlog(`event challenge_created service=${serviceId} challenge=${challengeId}`);
        let autoApprove = false;
        try {
          autoApprove = await shouldAutoApproveChallenge(serviceId, scopes);
        } catch (err) {
          dlog(`auto-approve check failed challenge=${challengeId} err=${err.message}`);
        }
        if (autoApprove) {
          dlog(`auto-approve start challenge=${challengeId}`);
          showAutoApprovedNotification(serviceId, scopes);
          try {
            await approveChallenge(challengeId);
            dlog(`auto-approve success challenge=${challengeId}`);
          } catch (err) {
            dlog(`auto-approve failed challenge=${challengeId} err=${err.message}`);
            showApproveNotification(serviceId, scopes);
          }
        } else {
          showApproveNotification(serviceId, scopes);
        }
      } else if (data.type === "login_reused") {
        const serviceId = data.payload.service_id;
        const scopes = data.payload.scopes || [];
        dlog(`event login_reused service=${serviceId}`);
        showReusedLoginNotification(serviceId, scopes);
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
  eventSource.addEventListener("login_reused", forward);
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

function createTrayIcon() {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
  <path fill="black" d="M9 1.5l6 3v4.8c0 3.7-2.1 6.1-6 7.2-3.9-1.1-6-3.5-6-7.2V4.5l6-3z"/>
  <circle cx="9" cy="8" r="2.2" fill="white"/>
</svg>`.trim();
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const icon = nativeImage.createFromDataURL(dataUrl);
  icon.setTemplateImage(true);
  return icon;
}

function createTray() {
  if (tray && !tray.isDestroyed()) {
    dlog("tray already exists");
    return;
  }
  tray = new Tray(createTrayIcon());
  tray.setTitle("MiID");
  tray.setToolTip("MiID Wallet Approvals");
  tray.on("click", () => openWindow());
  refreshTrayMenu();
  dlog("tray created");
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
  return approveChallenge(challengeId);
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
  if (process.env.MIID_HIDE_DOCK === "1") {
    if (process.platform === "darwin" && typeof app.setActivationPolicy === "function") {
      app.setActivationPolicy("accessory");
    }
    if (app.dock && typeof app.dock.hide === "function") {
      app.dock.hide();
    }
  }
  process.env.MIID_DATA_DIR = process.env.MIID_DATA_DIR || getWalletDataDir();
  process.env.WALLET_SIGN_SECRET = walletSignSecret;
  walletServer = startWalletServer({ port: WALLET_PORT });
  await ensureWalletDid();
  dlog(`app ready did=${walletDid || "none"} gateway=${GATEWAY_URL} config=${appConfigLoaded.configPath || "none"}`);
  createTray();
  connectEventStream();
  didSyncTimer = setInterval(syncDidFromStore, 3000);
});

app.on("second-instance", () => {
  dlog("second instance attempted; focusing existing window");
  createTray();
  openWindow();
});

app.on("window-all-closed", (e) => {
  if (!app.isQuiting) {
    e.preventDefault();
  }
});

app.on("before-quit", () => {
  app.isQuiting = true;
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
