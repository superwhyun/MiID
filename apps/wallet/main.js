const path = require("path");
const fs = require("fs");
const { app, Tray, Menu, BrowserWindow, ipcMain, Notification, nativeImage, screen } = require("electron");
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
let approvalStates = {};
const recentChallengeEvents = new Map();

function cryptoRandomSecret() {
  return require("crypto").randomBytes(24).toString("hex");
}

function getClaimPolicyPath() {
  return path.join(getWalletDataDir(), "claim-policies.json");
}

function getApprovalStatePath() {
  return path.join(getWalletDataDir(), "approval-states.json");
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
    // ignore disk errors; in-memory policy still works for current runtime
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

function loadApprovalStatesFromDisk() {
  try {
    const p = getApprovalStatePath();
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

function saveApprovalStatesToDisk() {
  try {
    const dir = getWalletDataDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(getApprovalStatePath(), JSON.stringify(approvalStates, null, 2));
  } catch (_err) {
    // ignore disk errors; in-memory state still works for current runtime
  }
}

function getApprovalState(did, serviceId) {
  const state = approvalStates[policyKey(did, serviceId)];
  if (!state || typeof state !== "object") {
    return null;
  }
  return {
    policy_hash: typeof state.policy_hash === "string" ? state.policy_hash : null,
    approved_version: Number.isInteger(state.approved_version) ? state.approved_version : null,
    approved_claims: Array.isArray(state.approved_claims) ? state.approved_claims : [],
    approved_at: state.approved_at || null
  };
}

function setApprovalState(did, serviceId, value) {
  if (!did || !serviceId || !value || typeof value !== "object") {
    return;
  }
  approvalStates[policyKey(did, serviceId)] = {
    policy_hash: typeof value.policy_hash === "string" ? value.policy_hash : null,
    approved_version: Number.isInteger(value.approved_version) ? value.approved_version : null,
    approved_claims: Array.isArray(value.approved_claims)
      ? [...new Set(value.approved_claims)].filter((v) => typeof v === "string")
      : [],
    approved_at: value.approved_at || new Date().toISOString()
  };
  saveApprovalStatesToDisk();
}

function clearApprovalState(did, serviceId) {
  if (!did || !serviceId) {
    return;
  }
  const key = policyKey(did, serviceId);
  if (approvalStates[key] !== undefined) {
    delete approvalStates[key];
    saveApprovalStatesToDisk();
  }
}

function clearClaimPolicy(did, serviceId) {
  if (!did || !serviceId) {
    return;
  }
  const key = policyKey(did, serviceId);
  if (claimPolicies[key] !== undefined) {
    delete claimPolicies[key];
    saveClaimPoliciesToDisk();
  }
}

function getWalletDids() {
  return wallets.map((w) => w.did).filter(Boolean);
}

function normalizeClaimList(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return [...new Set(list)]
    .filter((v) => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean)
    .sort();
}

function computePolicyHashFromChallenge(challenge) {
  const provided = challenge?.policy_hash;
  if (typeof provided === "string" && provided.length > 0) {
    return provided;
  }
  const scopes = normalizeClaimList(challenge?.scopes);
  const requestedClaims = normalizeClaimList(challenge?.requested_claims);
  const payload = JSON.stringify({
    scopes,
    requested_claims: requestedClaims,
    risk_action: challenge?.risk_action || null
  });
  return require("crypto").createHash("sha256").update(payload).digest("hex");
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
    const err = new Error(body.error || `http_${res.status}`);
    err.code = body.error || `http_${res.status}`;
    err.status = res.status;
    throw err;
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
  const challenges = Array.isArray(data.challenges) ? data.challenges : [];
  return challenges.map((challenge) => ({
    ...challenge,
    policy_hash: computePolicyHashFromChallenge(challenge)
  }));
}

async function getActiveServicesForDid(did) {
  const data = await fetchJson(`${GATEWAY_URL}/v1/wallet/sessions?did=${encodeURIComponent(did)}`);
  const activeServiceRows = Array.isArray(data.active_services)
    ? data.active_services
    : (Array.isArray(data.sessions) ? data.sessions : []);
  return activeServiceRows.map((row) => ({
    ...row,
    active_service_id: row.active_service_id || row.session_id
  }));
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

async function getActiveServices() {
  const dids = getWalletDids();
  if (dids.length === 0) {
    return [];
  }
  const perDid = await Promise.all(
    dids.map(async (did) => {
      try {
        const activeServices = await getActiveServicesForDid(did);
        return activeServices.map((s) => ({ ...s, did }));
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

async function seedApprovalStatesFromActiveServices() {
  const dids = getWalletDids();
  let changed = false;
  for (const did of dids) {
    let activeServices = [];
    try {
      activeServices = await getActiveServicesForDid(did);
    } catch (_err) {
      continue;
    }
    for (const activeService of activeServices) {
      const serviceId = activeService?.service_id;
      if (!serviceId) {
        continue;
      }
      const key = policyKey(did, serviceId);
      const existing = approvalStates[key];
      if (existing && typeof existing.policy_hash === "string" && existing.policy_hash.length > 0) {
        continue;
      }
      const policyHash = computePolicyHashFromChallenge({
        scopes: parseScope(activeService.scope),
        requested_claims: Array.isArray(activeService.requested_claims) ? activeService.requested_claims : [],
        risk_action: activeService.risk_level === "step_up" ? "step_up" : null
      });
      approvalStates[key] = {
        policy_hash: policyHash,
        approved_claims: Array.isArray(activeService.approved_claims)
          ? [...new Set(activeService.approved_claims)].filter((v) => typeof v === "string")
          : [],
        approved_at: new Date().toISOString()
      };
      changed = true;
    }
  }
  if (changed) {
    saveApprovalStatesToDisk();
  }
}

async function getWalletProfile(did) {
  if (!did) {
    return { did: null, profile: {} };
  }
  const data = await fetchJson(`${WALLET_URL}/v1/wallets/by-did/${encodeURIComponent(did)}`);
  return {
    did: data.did || did,
    profile: data.profile || {}
  };
}

async function updateWalletProfile(did, profile) {
  if (!did) {
    throw new Error("wallet_did_not_ready");
  }
  // profile 객체를 { profile: ... } 형태로 래핑하여 서버 규약에 맞춤
  const payload = { profile: { ...profile } };
  return fetchJson(`${WALLET_URL}/v1/wallets/by-did/${encodeURIComponent(did)}/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

// 기존 승인된 claims와 새로 요청된 claims를 비교하여 새로 추가된 것들을 반환
function getNewRequestedClaims(existingApproved, newRequested) {
  const approvedSet = new Set(existingApproved || []);
  return (newRequested || []).filter((claim) => !approvedSet.has(claim));
}

async function shouldAutoApproveChallenge(serviceId, serviceVersion, policyHash, requestedClaims, did) {
  if (!did) {
    return { autoApprove: false, newClaims: [] };
  }
  if (!Number.isInteger(serviceVersion) && !policyHash) {
    return { autoApprove: false, newClaims: [] };
  }
  const approvalState = getApprovalState(did, serviceId);
  if (!approvalState) {
    return { autoApprove: false, newClaims: [] };
  }
  const preferredClaims = getClaimPolicy(did, serviceId);
  const approvedClaims = Array.isArray(preferredClaims)
    ? preferredClaims
    : (Array.isArray(approvalState.approved_claims) ? approvalState.approved_claims : []);
  const newClaims = getNewRequestedClaims(approvedClaims, requestedClaims);
  const versionMatched = Number.isInteger(serviceVersion)
    && Number.isInteger(approvalState.approved_version)
    && approvalState.approved_version === serviceVersion;
  const hashMatched = Boolean(policyHash && approvalState.policy_hash && approvalState.policy_hash === policyHash);
  const policyMatched = Number.isInteger(serviceVersion) ? versionMatched : hashMatched;
  return {
    autoApprove: newClaims.length === 0 && policyMatched,
    newClaims,
    existingApproved: approvedClaims
  };
}

async function findAutoApproveDid(serviceId, serviceVersion, policyHash, requestedClaims = []) {
  if (!Number.isInteger(serviceVersion) && !policyHash) {
    return { did: null, autoApprove: false, newClaims: [] };
  }
  const dids = getWalletDids();
  for (const did of dids) {
    const result = await shouldAutoApproveChallenge(serviceId, serviceVersion, policyHash, requestedClaims, did);
    if (result.autoApprove) {
      return { did, ...result };
    }
  }
  return { did: null, autoApprove: false, newClaims: [] };
}

async function getAutoApprovedClaims(serviceId, requestedClaims, did) {
  const requested = Array.isArray(requestedClaims) ? requestedClaims : [];
  if (!did) {
    return [...requested];
  }
  const policyClaims = getClaimPolicy(did, serviceId);
  // User toggle policy is the highest-priority source, including explicit empty selection.
  if (Array.isArray(policyClaims)) {
    const selected = new Set(policyClaims);
    return requested.filter((claim) => selected.has(claim));
  }
  const approvalState = getApprovalState(did, serviceId);
  if (approvalState && Array.isArray(approvalState.approved_claims) && approvalState.approved_claims.length > 0) {
    const approved = new Set(approvalState.approved_claims);
    return requested.filter((claim) => approved.has(claim));
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

  const response = await fetchJson(`${GATEWAY_URL}/v1/wallet/challenges/${challengeId}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-idempotency-key": `wallet-approve:${challengeId}:${did}`
    },
    body: JSON.stringify({
      did,
      wallet_url: WALLET_URL,
      signature: sign.signature,
      approved_claims: Array.isArray(approvedClaims) ? approvedClaims : undefined
    })
  });

  if (response && !response.error) {
    const resolvedApprovedClaims = Array.isArray(approvedClaims)
      ? approvedClaims
      : (Array.isArray(response.approved_claims) ? response.approved_claims : (current.requested_claims || []));
    const currentPolicyHash = computePolicyHashFromChallenge(current);
    const currentServiceVersion = Number.isInteger(current.service_version)
      ? current.service_version
      : Number(current.service_version || 0);
    setApprovalState(did, current.service_id, {
      policy_hash: currentPolicyHash,
      approved_version: Number.isInteger(currentServiceVersion) ? currentServiceVersion : null,
      approved_claims: resolvedApprovedClaims,
      approved_at: new Date().toISOString()
    });
    try {
      await fetchJson(`${WALLET_URL}/v1/wallets/consents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          did,
          service_id: current.service_id,
          scopes: current.scopes
        })
      });
      dlog(`consent saved to wallet server did=${did} service=${current.service_id}`);
    } catch (err) {
      dlog(`failed to save consent to wallet server: ${err.message}`);
    }
  }

  return response;
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
  positionWindowTopRight();
  win.show();
  win.focus();
  dlog("window opened");
}

function positionWindowTopRight() {
  if (!win || win.isDestroyed()) {
    return;
  }
  const targetDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = targetDisplay?.workArea || screen.getPrimaryDisplay().workArea;
  const [width, height] = win.getSize();
  const margin = 16;
  const x = Math.round(area.x + area.width - width - margin);
  const y = Math.round(area.y + margin);
  win.setPosition(x, y);
}

function showApproveNotification(serviceName, scopes, newClaims = []) {
  const displayName = serviceName || "unknown-service";
  dlog(`notification service=${displayName} scopes=${(scopes || []).join(",")} newClaims=${(newClaims || []).join(",")}`);
  if (POPUP_ON_CHALLENGE) {
    openWindow();
  }
  try {
    const hasNewClaims = newClaims && newClaims.length > 0;
    const title = hasNewClaims ? "MiID 추가 정보 요청" : "MiID 승인 요청";
    const body = hasNewClaims
      ? `${displayName}가 새로운 정보를 요청합니다: ${newClaims.join(", ")}`
      : `${displayName}가 ${scopes.join(", ")} 요청`;
    const n = new Notification({ title, body });
    n.on("click", () => openWindow());
    n.show();
  } catch (err) {
    dlog(`notification failed: ${err.message}`);
  }
}

function showAutoApprovedNotification(serviceName, scopes) {
  const displayName = serviceName || "unknown-service";
  const n = new Notification({
    title: "MiID 자동 승인",
    body: `${displayName} ${scopes.join(", ")} 자동 승인됨`
  });
  n.on("click", () => openWindow());
  n.show();
}

function showReusedLoginNotification(serviceName, scopes) {
  const displayName = serviceName || "unknown-service";
  const n = new Notification({
    title: "MiID 로그인",
    body: `${displayName} 로그인 재사용 (${scopes.join(", ")})`
  });
  n.on("click", () => openWindow());
  n.show();
}

async function handleWalletEvent(data, sourceDid) {
  if (data.type === "challenge_created") {
    const serviceId = data.payload.service_id;
    const serviceName = data.payload.service_name || serviceId;
    const scopes = data.payload.scopes || [];
    const requestedClaims = data.payload.requested_claims || [];
    const serviceVersion = Number.isInteger(data.payload.service_version)
      ? data.payload.service_version
      : Number(data.payload.service_version || NaN);
    const policyHash = computePolicyHashFromChallenge(data.payload || {});
    const challengeId = data.payload.challenge_id;
    const didHint = data.payload.did_hint || null;

    if (isRecentChallengeEvent(challengeId)) {
      return;
    }

    dlog(`event challenge_created service=${serviceId} challenge=${challengeId} did_hint=${didHint || "none"}`);

    let targetDid = didHint || null;
    let autoApprove = false;
    let autoApprovedClaims = [];
    let newClaims = [];
    try {
      if (!targetDid) {
        if (getWalletDids().length === 1) {
          targetDid = getWalletDids()[0];
        } else {
          const findResult = await findAutoApproveDid(
            serviceId,
            Number.isInteger(serviceVersion) ? serviceVersion : null,
            policyHash,
            requestedClaims
          );
          targetDid = findResult.did;
          autoApprove = findResult.autoApprove;
          newClaims = findResult.newClaims || [];
        }
      }
      if (targetDid && !autoApprove) {
        const approveResult = await shouldAutoApproveChallenge(
          serviceId,
          Number.isInteger(serviceVersion) ? serviceVersion : null,
          policyHash,
          requestedClaims,
          targetDid
        );
        autoApprove = approveResult.autoApprove;
        newClaims = approveResult.newClaims || [];
      }
      if (targetDid) {
        autoApprovedClaims = await getAutoApprovedClaims(serviceId, requestedClaims, targetDid);
      }
    } catch (err) {
      dlog(`auto-approve check failed challenge=${challengeId} err=${err.message}`);
    }
    if (autoApprove) {
      dlog(`auto-approve start challenge=${challengeId} did=${targetDid}`);
      showAutoApprovedNotification(serviceName, scopes);
      try {
        await approveChallenge(challengeId, targetDid, autoApprovedClaims);
        dlog(`auto-approve success challenge=${challengeId}`);
      } catch (err) {
        dlog(`auto-approve failed challenge=${challengeId} err=${err.message}`);
        showApproveNotification(serviceName, scopes, newClaims);
      }
    } else {
      if (newClaims.length > 0) {
        dlog(`new claims detected challenge=${challengeId} newClaims=${newClaims.join(",")}`);
      }
      showApproveNotification(serviceName, scopes, newClaims);
    }
    return;
  }

  if (data.type === "login_reused") {
    const serviceId = data.payload.service_id;
    const serviceName = data.payload.service_name || serviceId;
    const scopes = data.payload.scopes || [];
    dlog(`event login_reused service=${serviceId} did=${sourceDid}`);
    showReusedLoginNotification(serviceName, scopes);
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

ipcMain.handle("active-services:list", async () => {
  const activeServices = await getActiveServices();
  dlog(`active services list count=${activeServices.length}`);
  return { active_services: activeServices };
});
ipcMain.handle("sessions:list", async () => {
  const activeServices = await getActiveServices();
  dlog(`sessions list count(compat)=${activeServices.length}`);
  return { sessions: activeServices, active_services: activeServices };
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

async function disconnectActiveService(payload) {
  const activeServiceId = typeof payload === "string"
    ? payload
    : (
      payload?.activeServiceId ||
      payload?.active_service_id ||
      payload?.sessionId ||
      payload?.session_id ||
      payload?.id
    );
  const did = payload?.did || primaryDid;
  let serviceId = payload?.serviceId || payload?.service_id || null;
  if (!activeServiceId) {
    throw new Error("active_service_id_required");
  }
  if (!serviceId && did) {
    try {
      const activeServices = await getActiveServicesForDid(did);
      const matched = activeServices.find((s) => (s.active_service_id || s.session_id) === activeServiceId);
      serviceId = matched?.service_id || null;
    } catch (_err) {
      // keep best effort behavior
    }
  }
  dlog(`active service disconnect id=${activeServiceId} did=${did}`);
  try {
    const result = await fetchJson(`${GATEWAY_URL}/v1/wallet/sessions/${encodeURIComponent(activeServiceId)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ did })
    });
    if (did && serviceId) {
      clearApprovalState(did, serviceId);
      clearClaimPolicy(did, serviceId);
    }
    return result;
  } catch (err) {
    if (err?.code === "already_revoked" || err?.code === "session_not_found") {
      if (did && serviceId) {
        clearApprovalState(did, serviceId);
        clearClaimPolicy(did, serviceId);
      }
      return {
        session_id: activeServiceId,
        status: "revoked",
        revoked_at: new Date().toISOString(),
        already_applied: true
      };
    }
    throw err;
  }
}

ipcMain.handle("active-service:disconnect", async (_event, payload) => {
  return disconnectActiveService(payload);
});
ipcMain.handle("session:revoke", async (_event, payload) => {
  return disconnectActiveService(payload);
});
ipcMain.handle("session:disconnect", async (_event, payload) => {
  return disconnectActiveService(payload);
});
ipcMain.handle("active-services:disconnect", async (_event, payload) => {
  return disconnectActiveService(payload);
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

ipcMain.handle("wallets:delete", async (_event, payload) => {
  const did = payload?.did;
  if (!did) {
    throw new Error("did_required");
  }
  dlog(`delete wallet did=${did}`);
  const result = await fetchJson(`${WALLET_URL}/v1/wallets/by-did/${encodeURIComponent(did)}`, {
    method: "DELETE"
  });
  await refreshWallets();
  refreshTrayMenu();
  connectEventStreams();
  broadcastWalletsChanged();
  return result;
});

ipcMain.handle("profile-fields:get", async () => {
  try {
    const configPath = path.join(__dirname, "..", "..", "config", "profile-fields.json");
    if (fs.existsSync(configPath)) {
      const fields = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return Array.isArray(fields) ? fields : [];
    }
  } catch (err) {
    dlog(`profile-fields load error: ${err.message}`);
  }
  // 기본값
  return [
    { label: "이름", key: "name", type: "text", placeholder: "실명을 입력하세요" },
    { label: "닉네임", key: "nickname", type: "text", placeholder: "표시될 이름" },
    { label: "이메일", key: "email", type: "email", placeholder: "email@example.com" }
  ];
});

app.whenReady().then(async () => {
  if (process.platform === "darwin" && typeof app.setActivationPolicy === "function") {
    app.setActivationPolicy("accessory");
  }
  if (process.platform === "darwin" && app.dock && typeof app.dock.hide === "function") {
    app.dock.hide();
  }
  process.env.MIID_DATA_DIR = process.env.MIID_DATA_DIR || getWalletDataDir();
  process.env.WALLET_SIGN_SECRET = walletSignSecret;
  claimPolicies = loadClaimPoliciesFromDisk();
  approvalStates = loadApprovalStatesFromDisk();
  walletServer = startWalletServer({ port: WALLET_PORT });
  await ensureWallets();
  await seedApprovalStatesFromActiveServices();
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
