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
const eventSources = new Map();
let wallets = [];
let primaryDid = process.env.WALLET_DID || null;
let claimPolicies = {};
const recentChallengeEvents = new Map();

function cryptoRandomSecret() {
  return require("crypto").randomBytes(24).toString("hex");
}

function getClaimPolicyPath() {
  return path.join(getWalletDataDir(), "claim-policies.json");
}

function policyKey(did, serviceId) {
  return `${did}::${serviceId}`;
}

function loadClaimPoliciesFromDisk() {
  try {
    const p = getClaimPolicyPath();
    if (!fs.existsSync(p)) {
      return {};
    }
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }
    return raw;
  } catch (_err) {
    return {};
  }
}

function saveClaimPoliciesToDisk() {
  try {
    const dir = getWalletDataDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(getClaimPolicyPath(), JSON.stringify(claimPolicies, null, 2));
  } catch (_err) {
    // ignore disk errors; in-memory policy still works for current session
  }
}

function setClaimPolicy(did, serviceId, claims) {
  if (!did || !serviceId) {
    return;
  }
  const normalized = Array.isArray(claims)
    ? [...new Set(claims)].filter((v) => typeof v === "string")
    : [];
  claimPolicies[policyKey(did, serviceId)] = normalized;
  saveClaimPoliciesToDisk();
}

function getClaimPolicy(did, serviceId) {
  const claims = claimPolicies[policyKey(did, serviceId)];
  return Array.isArray(claims) ? claims : null;
}

function getWalletDids() {
  return wallets.map((w) => w.did).filter(Boolean);
}

function isRecentChallengeEvent(challengeId, ttlMs = 2500) {
  if (!challengeId) {
    return false;
  }
  const now = Date.now();
  const prev = recentChallengeEvents.get(challengeId);
  recentChallengeEvents.set(challengeId, now);
  if (!prev) {
    return false;
  }
  return now - prev < ttlMs;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `http_${res.status}`);
  }
  return body;
}

async function listWallets() {
  const data = await fetchJson(`${WALLET_URL}/v1/wallets`);
  return Array.isArray(data.wallets) ? data.wallets : [];
}

async function createWallet(name = "desktop-user") {
  return fetchJson(`${WALLET_URL}/v1/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name })
  });
}

async function refreshWallets() {
  const list = await listWallets();
  wallets = list;
  const dids = getWalletDids();
  if (dids.length === 0) {
    primaryDid = null;
    return;
  }
  if (!primaryDid || !dids.includes(primaryDid)) {
    primaryDid = dids[0];
  }
}

async function ensureWallets() {
  await refreshWallets();
  if (wallets.length > 0) {
    return;
  }
  await createWallet("desktop-user");
  await refreshWallets();
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

async function getChallengesForDid(did) {
  const data = await fetchJson(`${GATEWAY_URL}/v1/wallet/challenges?did=${encodeURIComponent(did)}`);
  return Array.isArray(data.challenges) ? data.challenges : [];
}

async function getSessionsForDid(did) {
  const data = await fetchJson(`${GATEWAY_URL}/v1/wallet/sessions?did=${encodeURIComponent(did)}`);
  return Array.isArray(data.sessions) ? data.sessions : [];
}

async function getApprovedForDid(did) {
  const data = await fetchJson(`${GATEWAY_URL}/v1/wallet/approved?did=${encodeURIComponent(did)}`);
  return Array.isArray(data.approved) ? data.approved : [];
}

async function getChallenges() {
  const dids = getWalletDids();
  if (dids.length === 0) {
    return [];
  }
  const perDid = await Promise.all(
    dids.map(async (did) => {
      try {
        const challenges = await getChallengesForDid(did);
        return { did, challenges };
      } catch (_err) {
        return { did, challenges: [] };
      }
    })
  );

  const merged = new Map();
  perDid.forEach(({ did, challenges }) => {
    challenges.forEach((challenge) => {
      const existing = merged.get(challenge.challenge_id);
      if (!existing) {
        merged.set(challenge.challenge_id, {
          ...challenge,
          available_dids: challenge.did_hint ? [challenge.did_hint] : [did]
        });
        return;
      }
      if (!existing.available_dids.includes(did) && !challenge.did_hint) {
        existing.available_dids.push(did);
      }
    });
  });

  return Array.from(merged.values());
}

async function getSessions() {
  const dids = getWalletDids();
  if (dids.length === 0) {
    return [];
  }
  const perDid = await Promise.all(
    dids.map(async (did) => {
      try {
        const sessions = await getSessionsForDid(did);
        return sessions.map((s) => ({ ...s, did }));
      } catch (_err) {
        return [];
      }
    })
  );
  return perDid.flat();
}

async function getApproved() {
  const dids = getWalletDids();
  if (dids.length === 0) {
    return [];
  }
  const perDid = await Promise.all(
    dids.map(async (did) => {
      try {
        const approved = await getApprovedForDid(did);
        return approved.map((a) => ({ ...a, did }));
      } catch (_err) {
        return [];
      }
    })
  );
  return perDid.flat();
}

async function getWalletProfile(did) {
  if (!did) {
    return { did: null, name: null, email: null, nickname: null };
  }
  const data = await fetchJson(`${WALLET_URL}/v1/wallets/by-did/${encodeURIComponent(did)}`);
  return {
    did: data.did || did,
    name: data.name || null,
    email: data.email || null,
    nickname: data.nickname || null
  };
}

async function updateWalletProfile(did, profile) {
  if (!did) {
    throw new Error("wallet_did_not_ready");
  }
  const payload = {
    name: profile?.name || "",
    email: profile?.email || "",
    nickname: profile?.nickname || ""
  };
  return fetchJson(`${WALLET_URL}/v1/wallets/by-did/${encodeURIComponent(did)}/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function shouldAutoApproveChallenge(serviceId, scopes, did) {
  if (!did) {
    return false;
  }
  const sessions = await getSessionsForDid(did);
  return sessions.some((s) => s.service_id === serviceId && hasAllScopes(parseScope(s.scope), scopes));
}

async function findAutoApproveDid(serviceId, scopes) {
  const dids = getWalletDids();
  for (const did of dids) {
    // Reuse the first DID that already has an active compatible session.
    if (await shouldAutoApproveChallenge(serviceId, scopes, did)) {
      return did;
    }
  }
  return null;
}

async function getAutoApprovedClaims(serviceId, scopes, requestedClaims, did) {
  const requested = Array.isArray(requestedClaims) ? requestedClaims : [];
  if (!did) {
    return [...requested];
  }
  const policyClaims = getClaimPolicy(did, serviceId);
  if (policyClaims) {
    return requested.filter((claim) => policyClaims.includes(claim));
  }
  const sessions = await getSessionsForDid(did);
  const matched = sessions.find(
    (s) => s.service_id === serviceId && hasAllScopes(parseScope(s.scope), scopes)
  );
  const approved = Array.isArray(matched?.approved_claims) ? matched.approved_claims : [];
  if (approved.length > 0) {
    return requested.filter((claim) => approved.includes(claim));
  }
  return [...requested];
}

async function approveChallenge(challengeId, did, approvedClaims = null) {
  if (!did) {
    throw new Error("did_required");
  }
  const challengeStatus = await fetchJson(`${GATEWAY_URL}/v1/auth/challenges/${challengeId}/status`);
  if (challengeStatus.status !== "pending") {
    throw new Error(`challenge_not_pending:${challengeStatus.status}`);
  }
  const pending = await getChallengesForDid(did);
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
      did,
      challenge_id: challengeId,
      nonce: current.nonce,
      audience: current.client_id,
      expires_at: current.expires_at
    })
  });
  dlog(`approve signed challenge=${challengeId} did=${did}`);

  return fetchJson(`${GATEWAY_URL}/v1/wallet/challenges/${challengeId}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      did,
      wallet_url: WALLET_URL,
      signature: sign.signature,
      approved_claims: Array.isArray(approvedClaims) ? approvedClaims : undefined
    })
  });
}

function openWindow() {
  if (!win) {
    win = new BrowserWindow({
      width: 500,
      height: 760,
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

async function handleWalletEvent(data, sourceDid) {
  if (data.type === "challenge_created") {
    const serviceId = data.payload.service_id;
    const scopes = data.payload.scopes || [];
    const requestedClaims = data.payload.requested_claims || [];
    const challengeId = data.payload.challenge_id;
    const didHint = data.payload.did_hint || null;

    if (isRecentChallengeEvent(challengeId)) {
      return;
    }

    dlog(`event challenge_created service=${serviceId} challenge=${challengeId} did_hint=${didHint || "none"}`);

    let targetDid = didHint || null;
    let autoApprove = false;
    let autoApprovedClaims = [];
    try {
      if (!targetDid) {
        if (getWalletDids().length === 1) {
          targetDid = getWalletDids()[0];
        } else {
          targetDid = await findAutoApproveDid(serviceId, scopes);
        }
      }
      if (targetDid) {
        autoApprove = await shouldAutoApproveChallenge(serviceId, scopes, targetDid);
        autoApprovedClaims = await getAutoApprovedClaims(serviceId, scopes, requestedClaims, targetDid);
      }
    } catch (err) {
      dlog(`auto-approve check failed challenge=${challengeId} err=${err.message}`);
    }
    if (autoApprove) {
      dlog(`auto-approve start challenge=${challengeId} did=${targetDid}`);
      showAutoApprovedNotification(serviceId, scopes);
      try {
        await approveChallenge(challengeId, targetDid, autoApprovedClaims);
        dlog(`auto-approve success challenge=${challengeId}`);
      } catch (err) {
        dlog(`auto-approve failed challenge=${challengeId} err=${err.message}`);
        showApproveNotification(serviceId, scopes);
      }
    } else {
      showApproveNotification(serviceId, scopes);
    }
    return;
  }

  if (data.type === "login_reused") {
    const serviceId = data.payload.service_id;
    const scopes = data.payload.scopes || [];
    dlog(`event login_reused service=${serviceId} did=${sourceDid}`);
    showReusedLoginNotification(serviceId, scopes);
  }
}

function closeEventStreams() {
  eventSources.forEach((es) => {
    try {
      es.close();
    } catch (_err) {
      // ignore
    }
  });
  eventSources.clear();
}

function connectEventStreams() {
  closeEventStreams();
  const dids = getWalletDids();
  dids.forEach((did) => {
    dlog(`connect wallet event stream did=${did}`);
    const es = new EventSource(`${GATEWAY_URL}/v1/wallet/events?did=${encodeURIComponent(did)}`);
    const forward = async (event) => {
      try {
        const data = JSON.parse(event.data);
        await handleWalletEvent(data, did);
        if (win && !win.isDestroyed()) {
          win.webContents.send("challenge:event", data);
        }
      } catch (_err) {
        // ignore bad event payload
      }
    };
    es.addEventListener("challenge_created", forward);
    es.addEventListener("challenge_approved", forward);
    es.addEventListener("challenge_denied", forward);
    es.addEventListener("session_created", forward);
    es.addEventListener("session_revoked", forward);
    es.addEventListener("approved_cancelled", forward);
    es.addEventListener("login_reused", forward);
    es.onerror = () => {
      dlog(`wallet event stream error did=${did} (auto-retry)`);
    };
    eventSources.set(did, es);
  });
}

function refreshTrayMenu() {
  if (!tray) {
    return;
  }
  const dids = getWalletDids();
  const menu = Menu.buildFromTemplate([
    { label: "Open Approvals", click: () => openWindow() },
    { type: "separator" },
    {
      label: primaryDid ? `Primary DID: ${primaryDid}` : "Primary DID: not found",
      enabled: false
    },
    {
      label: `DID Count: ${dids.length}`,
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

function broadcastWalletsChanged() {
  if (win && !win.isDestroyed()) {
    win.webContents.send("challenge:event", {
      type: "wallets_changed",
      payload: {
        dids: getWalletDids(),
        primary_did: primaryDid
      }
    });
  }
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
  dlog(`context requested primary=${primaryDid || "none"}`);
  return {
    did: primaryDid,
    primary_did: primaryDid,
    dids: getWalletDids(),
    wallets,
    gatewayUrl: GATEWAY_URL,
    walletUrl: WALLET_URL
  };
});

ipcMain.handle("wallets:list", async () => {
  await refreshWallets();
  return { wallets, primary_did: primaryDid };
});

ipcMain.handle("wallets:create", async (_event, payload) => {
  const name = payload?.name || "user";
  const created = await createWallet(name);
  await refreshWallets();
  refreshTrayMenu();
  connectEventStreams();
  broadcastWalletsChanged();
  return created;
});

ipcMain.handle("profile:get", async (_event, payload) => {
  const did = payload?.did || primaryDid;
  return getWalletProfile(did);
});

ipcMain.handle("profile:update", async (_event, payload) => {
  const did = payload?.did || primaryDid;
  return updateWalletProfile(did, payload?.profile || payload || {});
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

ipcMain.handle("approved:cancel", async (_event, payload) => {
  const authorizationCode = typeof payload === "string" ? payload : payload?.authorizationCode;
  const did = payload?.did || primaryDid;
  dlog(`approved cancel code=${authorizationCode}`);
  return fetchJson(`${GATEWAY_URL}/v1/wallet/approved/${encodeURIComponent(authorizationCode)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did })
  });
});

ipcMain.handle("session:revoke", async (_event, payload) => {
  const sessionId = typeof payload === "string" ? payload : payload?.sessionId;
  const did = payload?.did || primaryDid;
  dlog(`session revoke id=${sessionId} did=${did}`);
  return fetchJson(`${GATEWAY_URL}/v1/wallet/sessions/${sessionId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did })
  });
});

ipcMain.handle("claim-policy:set", async (_event, payload) => {
  setClaimPolicy(payload?.did, payload?.serviceId, payload?.claims);
  return { ok: true };
});

ipcMain.handle("claim-policy:get", async (_event, payload) => {
  const claims = getClaimPolicy(payload?.did, payload?.serviceId);
  return { claims: claims || [] };
});

ipcMain.handle("challenge:approve", async (_event, payload) => {
  const challengeId = typeof payload === "string" ? payload : payload?.challengeId;
  const approvedClaims = typeof payload === "object" ? payload?.approvedClaims : null;
  const did = payload?.did || primaryDid;
  dlog(`approve requested challenge=${challengeId} did=${did}`);
  return approveChallenge(challengeId, did, approvedClaims);
});

ipcMain.handle("challenge:deny", async (_event, payload) => {
  const challengeId = typeof payload === "string" ? payload : payload?.challengeId;
  const did = payload?.did || primaryDid;
  dlog(`deny requested challenge=${challengeId} did=${did}`);
  return fetchJson(`${GATEWAY_URL}/v1/wallet/challenges/${challengeId}/deny`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did })
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
  claimPolicies = loadClaimPoliciesFromDisk();
  walletServer = startWalletServer({ port: WALLET_PORT });
  await ensureWallets();
  dlog(`app ready dids=${getWalletDids().length} primary=${primaryDid || "none"} gateway=${GATEWAY_URL} config=${appConfigLoaded.configPath || "none"}`);
  createTray();
  connectEventStreams();
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
  closeEventStreams();
  if (walletServer) {
    walletServer.close();
  }
});
