const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// DB modules
const { getDb } = require("./db");
const { initializeSchema } = require("./db/schema");
const { startCleanupScheduler } = require("./db/cleanup");
const store = require("./db/store");

const PORT = process.env.GATEWAY_PORT || 14000;
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const SERVICES_FILE = path.join(DATA_DIR, "services.json");
const DEBUG_AUTH = process.env.DEBUG_AUTH === "1";
const REQUIRE_WALLET_APPROVAL_FOR_REUSE = process.env.REQUIRE_WALLET_APPROVAL_FOR_REUSE !== "0";
const REQUIRE_LOCAL_WALLET_READY = process.env.LOCAL_WALLET_REQUIRED !== "0";
const WALLET_AUTHORITATIVE_MODE = process.env.WALLET_AUTHORITATIVE_MODE !== "0";

let SERVICE_REGISTRY = new Map();

function dlog(message) {
  if (DEBUG_AUTH) {
    console.log(`[gateway] ${message}`);
  }
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(SERVICES_FILE)) {
    fs.writeFileSync(SERVICES_FILE, JSON.stringify([], null, 2));
  }
}

function loadServiceRegistry() {
  ensureDataDir();
  const defaultClientId = process.env.SERVICE_CLIENT_ID || "web-client";
  const defaultServiceId = process.env.SERVICE_ID || "service-test";
  const defaultClientSecret = process.env.SERVICE_CLIENT_SECRET || "dev-service-secret";
  const defaultRedirectUri = process.env.SERVICE_REDIRECT_URI || "https://service-test.local/callback";

  let services = [];
  try {
    const data = JSON.parse(fs.readFileSync(SERVICES_FILE, "utf8"));
    services = Array.isArray(data) ? data : [];
  } catch (err) {
    dlog(`Failed to read services.json: ${err.message}`);
  }

  const registry = new Map();

  if (!services.find(s => s.client_id === defaultClientId)) {
    const defaultPolicy = {
      default_scopes: ["profile", "email"],
      requested_claims: normalizeRequestedClaims((process.env.REQUESTED_CLAIMS || "name,email,nickname").split(",")),
      risk_action: null
    };
    registry.set(defaultClientId, {
      client_id: defaultClientId,
      service_id: defaultServiceId,
      client_secret: defaultClientSecret,
      redirect_uris: [defaultRedirectUri],
      default_scopes: defaultPolicy.default_scopes,
      requested_claims: defaultPolicy.requested_claims,
      risk_action: defaultPolicy.risk_action,
      service_version: 1,
      policy_hash: buildServicePolicyHash(defaultPolicy)
    });
  }

  services.forEach(s => {
    const normalized = {
      ...s,
      default_scopes: normalizeScopes(s.default_scopes),
      requested_claims: normalizeRequestedClaims(s.requested_claims),
      risk_action: s.risk_action || null
    };
    normalized.service_version = Number.isInteger(normalized.service_version) ? normalized.service_version : 1;
    normalized.policy_hash = typeof normalized.policy_hash === "string" && normalized.policy_hash.length > 0
      ? normalized.policy_hash
      : buildServicePolicyHash(normalized);
    registry.set(normalized.client_id, normalized);
  });

  SERVICE_REGISTRY = registry;
}

function readServices() {
  ensureDataDir();
  return JSON.parse(fs.readFileSync(SERVICES_FILE, "utf8"));
}

function writeServices(services) {
  fs.writeFileSync(SERVICES_FILE, JSON.stringify(services, null, 2));
}

function authenticateServiceClient(req, res) {
  const clientId = req.headers["x-client-id"];
  const clientSecret = req.headers["x-client-secret"];
  if (!clientId || !clientSecret) {
    res.status(401).json({ error: "service_client_auth_required" });
    return null;
  }

  loadServiceRegistry();

  const service = SERVICE_REGISTRY.get(clientId);
  if (!service || service.client_secret !== clientSecret) {
    res.status(401).json({ error: "invalid_service_client_credentials" });
    return null;
  }
  return service;
}

function toPayloadString(payload) {
  return JSON.stringify(payload);
}

function hasAllScopes(consentScopes, requestedScopes) {
  const set = new Set(consentScopes);
  return requestedScopes.every((s) => set.has(s));
}

function parseScopeText(scopeText) {
  if (!scopeText || typeof scopeText !== "string") {
    return [];
  }
  return scopeText.split(" ").map((s) => s.trim()).filter(Boolean);
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return ["profile", "email"];
  }
  return [...new Set(scopes)]
    .filter((scope) => typeof scope === "string")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function normalizeRequestedClaims(requestedClaims) {
  if (!Array.isArray(requestedClaims) || requestedClaims.length === 0) {
    return [];
  }
  return [...new Set(requestedClaims)]
    .filter((claim) => typeof claim === "string")
    .map((claim) => claim.trim())
    .filter((claim) => claim.length > 0);
}

function buildServicePolicyHash(policy = {}) {
  return buildPolicyHash(
    normalizeScopes(policy.default_scopes),
    normalizeRequestedClaims(policy.requested_claims),
    policy.risk_action || null
  );
}

function buildPolicyHash(scopes = [], requestedClaims = [], riskAction = null) {
  const normalizedScopes = [...new Set(Array.isArray(scopes) ? scopes : [])].sort();
  const normalizedClaims = normalizeRequestedClaims(requestedClaims).sort();
  const payload = JSON.stringify({
    scopes: normalizedScopes,
    requested_claims: normalizedClaims,
    risk_action: riskAction || null
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function getChallengePolicyHash(challenge) {
  return buildPolicyHash(challenge?.scopes, challenge?.requested_claims, challenge?.risk_action);
}

function filterProfileClaims(profileClaims, approvedClaims) {
  const approvedArr = Array.isArray(approvedClaims) ? approvedClaims : [];
  const filtered = {};
  approvedArr.forEach((claim) => {
    filtered[claim] = profileClaims[claim] !== undefined ? profileClaims[claim] : null;
  });
  return filtered;
}

function toSafeText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeWalletProfile(wallet) {
  if (!wallet || typeof wallet !== "object") {
    return {};
  }
  if (wallet.profile && typeof wallet.profile === "object") {
    const normalized = {};
    Object.entries(wallet.profile).forEach(([key, data]) => {
      if (typeof data === "object") {
        normalized[key] = data.value || null;
      } else {
        normalized[key] = data || null;
      }
    });
    return normalized;
  }
  return {
    name: toSafeText(wallet.name),
    email: toSafeText(wallet.email),
    nickname: toSafeText(wallet.nickname)
  };
}

async function fetchWalletByDid(walletUrl, did) {
  const res = await fetch(`${walletUrl}/v1/wallets/by-did/${encodeURIComponent(did)}`);
  if (!res.ok) {
    throw new Error(`wallet did lookup failed: ${res.status}`);
  }
  return res.json();
}

function buildDidDocumentFromWalletRecord(wallet) {
  const did = wallet.did;
  const keyId = wallet.kid || `${did}#key-1`;
  return {
    id: did,
    verificationMethod: [
      {
        id: keyId,
        type: "Ed25519VerificationKey2020",
        controller: did,
        publicKeyPem: wallet.public_key_pem
      }
    ],
    authentication: [keyId]
  };
}

function resolveVerificationMethod(didDocument, kidHint = null) {
  const verificationMethods = Array.isArray(didDocument?.verificationMethod)
    ? didDocument.verificationMethod
    : [];
  if (verificationMethods.length === 0) {
    throw new Error("did_document_has_no_verification_method");
  }
  if (kidHint) {
    const matched = verificationMethods.find((vm) => vm.id === kidHint);
    if (matched) {
      return matched;
    }
  }
  const authRefs = Array.isArray(didDocument?.authentication) ? didDocument.authentication : [];
  const firstAuthRef = authRefs.find((entry) => typeof entry === "string");
  if (firstAuthRef) {
    const matched = verificationMethods.find((vm) => vm.id === firstAuthRef);
    if (matched) {
      return matched;
    }
  }
  return verificationMethods[0];
}

function verifyWithDidDocument(didDocument, payload, signatureBase64Url, kidHint = null) {
  const method = resolveVerificationMethod(didDocument, kidHint);
  if (!method.publicKeyPem) {
    throw new Error("did_document_method_missing_public_key");
  }
  return crypto.verify(
    null,
    Buffer.from(payload),
    method.publicKeyPem,
    Buffer.from(signatureBase64Url, "base64url")
  );
}

async function resolveDidDocument({ did, walletUrl }) {
  if (!did || typeof did !== "string") {
    throw new Error("did_required");
  }
  if (did.startsWith("did:miid:")) {
    if (!walletUrl) {
      throw new Error("wallet_url_required_for_did_miid");
    }
    const wallet = await fetchWalletByDid(walletUrl, did);
    return {
      didDocument: buildDidDocumentFromWalletRecord(wallet),
      wallet
    };
  }
  throw new Error(`unsupported_did_method:${did.split(":")[1] || "unknown"}`);
}

function issueAuthCodeFromChallenge(challenge, did, walletProfile = null, approvedClaims = null, walletUrl = null) {
  const subjectId = store.findOrCreateSubject(did, challenge.service_id);
  const activeConsents = store.findActiveConsents(challenge.service_id, subjectId);
  const latestConsent = activeConsents[0];
  const missing = latestConsent
    ? challenge.scopes.filter((s) => !latestConsent.scopes.includes(s))
    : challenge.scopes;

  const authCode = {
    id: crypto.randomUUID(),
    code: `ac_${store.randomToken(16)}`,
    challenge_id: challenge.id,
    service_id: challenge.service_id,
    client_id: challenge.client_id,
    redirect_uri: challenge.redirect_uri,
    did,
    subject_id: subjectId,
    scopes: challenge.scopes,
    consent_required: missing.length > 0,
    missing_scopes: missing,
    risk_action: challenge.risk_action,
    requested_claims: challenge.requested_claims || [],
    approved_claims: approvedClaims || challenge.requested_claims || [],
    profile_claims: walletProfile,
    wallet_url: walletUrl || null,
    expires_at: store.addMinutes(store.nowIso(), 2),
    created_at: store.nowIso()
  };

  store.updateChallengeStatus(challenge.id, {
    used_at: store.nowIso(),
    status: "verified",
    verified_at: store.nowIso(),
    authorization_code: authCode.code
  });

  store.insertAuthCode(authCode);
  return authCode;
}

function requireBearer(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing_bearer_token" });
  }
  req.accessToken = auth.slice("Bearer ".length);
  return next();
}

const app = express();
app.use(express.json());
const walletStreams = new Map();
const challengeStreams = new Map();
const serviceSessionStreams = new Map();

function addWalletStream(did, res) {
  const current = walletStreams.get(did) || new Set();
  current.add(res);
  walletStreams.set(did, current);
}

function removeWalletStream(did, res) {
  const current = walletStreams.get(did);
  if (!current) {
    return;
  }
  current.delete(res);
  if (current.size === 0) {
    walletStreams.delete(did);
  }
}

function pushWalletEvent(did, type, payload) {
  const current = walletStreams.get(did);
  if (!current) {
    return;
  }
  const body = JSON.stringify({ type, payload, at: store.nowIso() });
  current.forEach((res) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${body}\n\n`);
  });
}

function addChallengeStream(challengeId, res) {
  const current = challengeStreams.get(challengeId) || new Set();
  current.add(res);
  challengeStreams.set(challengeId, current);
}

function removeChallengeStream(challengeId, res) {
  const current = challengeStreams.get(challengeId);
  if (!current) {
    return;
  }
  current.delete(res);
  if (current.size === 0) {
    challengeStreams.delete(challengeId);
  }
}

function pushChallengeEvent(challengeId, type, payload) {
  const current = challengeStreams.get(challengeId);
  if (!current) {
    dlog(`pushChallengeEvent failed: no stream for challenge=${challengeId} type=${type}`);
    return;
  }
  dlog(`pushChallengeEvent challenge=${challengeId} type=${type}`);
  const body = JSON.stringify({ type, payload, at: store.nowIso() });
  current.forEach((res) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${body}\n\n`);
  });
}

function broadcastWalletEvent(type, payload) {
  const body = JSON.stringify({ type, payload, at: store.nowIso() });
  walletStreams.forEach((clients) => {
    clients.forEach((res) => {
      res.write(`event: ${type}\n`);
      res.write(`data: ${body}\n\n`);
    });
  });
}

function addServiceSessionStream(serviceId, res) {
  const current = serviceSessionStreams.get(serviceId) || new Set();
  current.add(res);
  serviceSessionStreams.set(serviceId, current);
}

function removeServiceSessionStream(serviceId, res) {
  const current = serviceSessionStreams.get(serviceId);
  if (!current) {
    return;
  }
  current.delete(res);
  if (current.size === 0) {
    serviceSessionStreams.delete(serviceId);
  }
}

function pushServiceSessionEvent(serviceId, type, payload) {
  const current = serviceSessionStreams.get(serviceId);
  if (!current) {
    return;
  }
  const body = JSON.stringify({ type, payload, at: store.nowIso() });
  current.forEach((res) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${body}\n\n`);
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "gateway", now: store.nowIso() });
});

app.post("/v1/services", (req, res) => {
  const service = authenticateServiceClient(req, res);
  if (!service) {
    return;
  }
  const {
    client_id,
    service_id,
    client_secret,
    redirect_uris,
    requested_claims,
    default_scopes,
    risk_action
  } = req.body || {};
  if (!client_id || !service_id || !client_secret || !Array.isArray(redirect_uris)) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const services = readServices();
  const existingIndex = services.findIndex((s) => s.client_id === client_id);
  const existingService = existingIndex >= 0 ? services[existingIndex] : null;
  const nextPolicy = {
    default_scopes: normalizeScopes(default_scopes || existingService?.default_scopes),
    requested_claims: normalizeRequestedClaims(requested_claims || existingService?.requested_claims),
    risk_action: risk_action || existingService?.risk_action || null
  };
  const nextPolicyHash = buildServicePolicyHash(nextPolicy);
  const previousVersion = Number.isInteger(existingService?.service_version) ? existingService.service_version : 1;
  const previousPolicyHash = typeof existingService?.policy_hash === "string" ? existingService.policy_hash : null;
  const serviceVersion = !existingService
    ? 1
    : (previousPolicyHash !== nextPolicyHash ? previousVersion + 1 : previousVersion);
  const newService = {
    client_id,
    service_id,
    client_secret,
    redirect_uris,
    default_scopes: nextPolicy.default_scopes,
    requested_claims: nextPolicy.requested_claims,
    risk_action: nextPolicy.risk_action,
    service_version: serviceVersion,
    policy_hash: nextPolicyHash,
    updated_at: store.nowIso()
  };

  if (existingIndex >= 0) {
    services[existingIndex] = newService;
  } else {
    services.push(newService);
  }

  writeServices(services);
  loadServiceRegistry();
  dlog(`service registered/updated: ${client_id} version=${newService.service_version}`);
  res.json({ success: true, service: newService });
});

app.delete("/v1/services/:clientId", (req, res) => {
  const service = authenticateServiceClient(req, res);
  if (!service) {
    return;
  }

  const clientId = req.params.clientId;
  if (service.client_id !== clientId) {
    return res.status(403).json({ error: "client_id_mismatch" });
  }

  const services = readServices();
  const existingIndex = services.findIndex((s) => s.client_id === clientId);
  if (existingIndex < 0) {
    return res.status(404).json({ error: "service_not_found" });
  }

  const deleted = services[existingIndex];
  services.splice(existingIndex, 1);

  writeServices(services);
  loadServiceRegistry();

  const sessionSubscribers = serviceSessionStreams.get(deleted.service_id);
  if (sessionSubscribers) {
    sessionSubscribers.forEach((streamRes) => streamRes.end());
    serviceSessionStreams.delete(deleted.service_id);
  }

  dlog(`service deleted: ${clientId}`);
  return res.json({
    success: true,
    deleted: { client_id: deleted.client_id, service_id: deleted.service_id }
  });
});

app.get("/v1/wallet/events", (req, res) => {
  const did = req.query.did;
  if (!did) {
    return res.status(400).json({ error: "did_required" });
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  dlog(`wallet events connected did=${did}`);
  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({ did, at: store.nowIso() })}\n\n`);
  addWalletStream(did, res);
  const keepAlive = setInterval(() => {
    res.write(`event: ping\ndata: {}\n\n`);
  }, 15000);
  req.on("close", () => {
    clearInterval(keepAlive);
    removeWalletStream(did, res);
    dlog(`wallet events disconnected did=${did}`);
  });
});

app.get("/v1/service/events", (req, res) => {
  const service = authenticateServiceClient(req, res);
  if (!service) {
    return;
  }
  const challengeId = req.query.challenge_id;
  if (!challengeId) {
    return res.status(400).json({ error: "challenge_id_required" });
  }

  const challenge = store.findChallengeById(challengeId);
  if (!challenge) {
    return res.status(404).json({ error: "challenge_not_found" });
  }
  if (challenge.client_id !== service.client_id) {
    return res.status(403).json({ error: "challenge_client_mismatch" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  dlog(`service events connected challenge_id=${challengeId} client_id=${service.client_id}`);
  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({ challenge_id: challengeId, at: store.nowIso() })}\n\n`);

  addChallengeStream(challengeId, res);
  const keepAlive = setInterval(() => {
    dlog(`service events ping challenge_id=${challengeId}`);
    res.write(`event: ping\ndata: {}\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    removeChallengeStream(challengeId, res);
    dlog(`service events disconnected challenge_id=${challengeId}`);
  });
});

app.get("/v1/service/session-events", (req, res) => {
  const service = authenticateServiceClient(req, res);
  if (!service) {
    return;
  }
  const serviceId = service.service_id;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  dlog(`service session events connected service_id=${serviceId}`);
  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({ service_id: serviceId, at: store.nowIso() })}\n\n`);
  addServiceSessionStream(serviceId, res);
  const keepAlive = setInterval(() => {
    res.write(`event: ping\ndata: {}\n\n`);
  }, 15000);
  req.on("close", () => {
    clearInterval(keepAlive);
    removeServiceSessionStream(serviceId, res);
    dlog(`service session events disconnected service_id=${serviceId}`);
  });
});

app.post("/v1/auth/challenge", (req, res) => {
  const service = authenticateServiceClient(req, res);
  if (!service) {
    return;
  }
  if (REQUIRE_LOCAL_WALLET_READY) {
    const localWalletReady = req.headers["x-local-wallet-ready"] === "1";
    if (!localWalletReady) {
      return res.status(409).json({
        error: "wallet_local_required",
        message: "Local wallet readiness check is required before challenge creation."
      });
    }
    if (walletStreams.size === 0) {
      return res.status(409).json({
        error: "wallet_local_unreachable",
        message: "No wallet is currently connected to gateway."
      });
    }
  }
  const {
    service_id,
    client_id,
    redirect_uri,
    scopes,
    state,
    risk_action,
    did_hint,
    require_user_approval,
    requested_claims,
    service_version
  } = req.body || {};
  if (!client_id || !redirect_uri || !Array.isArray(scopes) || scopes.length === 0) {
    return res.status(400).json({ error: "invalid_request" });
  }
  if (client_id !== service.client_id) {
    return res.status(403).json({ error: "client_id_mismatch" });
  }
  if (service_id && service_id !== service.service_id) {
    return res.status(403).json({ error: "service_id_mismatch" });
  }
  if (!service.redirect_uris.includes(redirect_uri)) {
    return res.status(403).json({ error: "redirect_uri_not_allowed" });
  }
  if (service_version !== undefined && Number(service_version) !== Number(service.service_version || 1)) {
    return res.status(409).json({
      error: "service_version_mismatch",
      expected_service_version: Number(service.service_version || 1)
    });
  }
  if (did_hint && REQUIRE_LOCAL_WALLET_READY && !walletStreams.has(did_hint)) {
    return res.status(409).json({
      error: "wallet_local_unreachable",
      message: "Target wallet is not connected."
    });
  }

  const normalizedScopes = [...new Set(scopes)];
  const normalizedRequestedClaims = normalizeRequestedClaims(requested_claims);
  const challenge = {
    id: crypto.randomUUID(),
    nonce: store.randomToken(18),
    service_id: service.service_id,
    client_id: service.client_id,
    redirect_uri,
    scopes: normalizedScopes,
    requested_claims: normalizedRequestedClaims,
    service_version: Number(service.service_version || 1),
    state: state || null,
    risk_action: risk_action || null,
    did_hint: did_hint || null,
    require_user_approval: require_user_approval !== false,
    status: "pending",
    expires_at: store.addMinutes(store.nowIso(), 5),
    created_at: store.nowIso()
  };

  store.insertChallenge(challenge);
  dlog(`challenge created id=${challenge.id} did_hint=${challenge.did_hint || "none"} service=${challenge.service_id}`);

  const eventPayload = {
    challenge_id: challenge.id,
    service_id: challenge.service_id,
    did_hint: challenge.did_hint,
    scopes: challenge.scopes,
    service_version: challenge.service_version,
    requested_claims: challenge.requested_claims,
    policy_hash: getChallengePolicyHash(challenge),
    expires_at: challenge.expires_at
  };
  if (challenge.did_hint) {
    pushWalletEvent(challenge.did_hint, "challenge_created", eventPayload);
  } else {
    broadcastWalletEvent("challenge_created", eventPayload);
  }

  return res.status(201).json({
    challenge_id: challenge.id,
    nonce: challenge.nonce,
    expires_at: challenge.expires_at,
    status: challenge.status,
    service_version: challenge.service_version,
    requested_claims: challenge.requested_claims,
    policy_hash: getChallengePolicyHash(challenge)
  });
});

app.post("/v1/auth/reuse-session", (req, res) => {
  if (WALLET_AUTHORITATIVE_MODE) {
    return res.status(403).json({
      error: "wallet_authoritative_mode_enabled",
      message: "Session reuse shortcut is disabled. Route all login requests through wallet approval."
    });
  }
  const service = authenticateServiceClient(req, res);
  if (!service) {
    return;
  }
  if (REQUIRE_WALLET_APPROVAL_FOR_REUSE) {
    return res.status(403).json({
      error: "wallet_approval_required",
      message: "Session reuse is disabled until wallet approval is completed."
    });
  }
  const { did, scopes } = req.body || {};
  if (!did || !Array.isArray(scopes) || scopes.length === 0) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const reusable = store.findReusableSession(service.service_id, did, scopes);
  if (!reusable) {
    return res.status(404).json({ error: "no_reusable_session" });
  }
  dlog(`reused session lookup hit did=${did} service=${service.service_id} session=${reusable.id}`);
  return res.json({
    reused: true,
    session_id: reusable.id,
    access_token: reusable.access_token,
    refresh_token: reusable.refresh_token,
    scope: reusable.scope,
    expires_at: reusable.expires_at
  });
});

app.post("/v1/wallet/notify-reuse", (req, res) => {
  const service = authenticateServiceClient(req, res);
  if (!service) {
    return;
  }
  const { did, scopes } = req.body || {};
  if (!did) {
    return res.status(400).json({ error: "did_required" });
  }
  const payload = {
    service_id: service.service_id,
    scopes: Array.isArray(scopes) ? scopes : [],
    reused: true,
    at: store.nowIso()
  };
  pushWalletEvent(did, "login_reused", payload);
  dlog(`wallet notified reused login did=${did} service=${service.service_id}`);
  return res.json({ ok: true });
});

app.post("/v1/auth/verify", async (req, res) => {
  try {
    const { challenge_id, did, signature, wallet_url } = req.body || {};
    if (!challenge_id || !did || !signature || !wallet_url) {
      return res.status(400).json({ error: "invalid_request" });
    }

    const challenge = store.findChallengeById(challenge_id);
    if (!challenge) {
      return res.status(404).json({ error: "challenge_not_found" });
    }
    if (challenge.used_at) {
      return res.status(409).json({ error: "challenge_already_used" });
    }
    if (challenge.require_user_approval) {
      return res.status(403).json({
        error: "user_approval_required",
        message: "Use /v1/wallet/challenges/:challengeId/approve for user-confirmed login."
      });
    }
    if (challenge.did_hint && challenge.did_hint !== did) {
      return res.status(403).json({ error: "did_mismatch" });
    }
    if (new Date(challenge.expires_at) < new Date()) {
      return res.status(401).json({ error: "challenge_expired" });
    }

    const resolved = await resolveDidDocument({ did, walletUrl: wallet_url });
    const wallet = resolved.wallet;
    const walletProfile = normalizeWalletProfile(wallet);
    const payload = toPayloadString({
      challenge_id: challenge.id,
      nonce: challenge.nonce,
      audience: challenge.client_id,
      expires_at: challenge.expires_at
    });
    const ok = verifyWithDidDocument(resolved.didDocument, payload, signature);
    if (!ok) {
      return res.status(401).json({ error: "invalid_signature" });
    }

    const approvedClaims = normalizeRequestedClaims(challenge.requested_claims);
    const filteredProfile = filterProfileClaims(walletProfile, approvedClaims);
    const authCode = issueAuthCodeFromChallenge(challenge, did, filteredProfile, approvedClaims, wallet_url);

    return res.json({
      authorization_code: authCode.code,
      code_expires_at: authCode.expires_at,
      subject_id: authCode.subject_id,
      consent_required: authCode.consent_required,
      missing_scopes: authCode.missing_scopes,
      approved_claims: authCode.approved_claims
    });
  } catch (err) {
    return res.status(500).json({ error: "verify_failed", message: err.message });
  }
});

app.get("/v1/auth/challenges/:challengeId/status", (req, res) => {
  const challenge = store.findChallengeById(req.params.challengeId);
  if (!challenge) {
    return res.status(404).json({ error: "challenge_not_found" });
  }

  if (new Date(challenge.expires_at) < new Date() && challenge.status === "pending") {
    store.updateChallengeStatus(challenge.id, { status: "expired" });
    challenge.status = "expired";
    pushChallengeEvent(challenge.id, "challenge_expired", { challenge_id: challenge.id });
    if (challenge.did_hint) {
      pushWalletEvent(challenge.did_hint, "challenge_expired", { challenge_id: challenge.id });
    }
  }

  return res.json({
    challenge_id: challenge.id,
    status: challenge.status,
    authorization_code: challenge.authorization_code,
    verified_at: challenge.verified_at,
    denied_at: challenge.denied_at,
    expires_at: challenge.expires_at
  });
});

app.get("/v1/wallet/challenges", (req, res) => {
  const did = req.query.did;
  if (!did) {
    return res.status(400).json({ error: "did_required" });
  }

  const challenges = store.findPendingChallenges(did);
  const pending = challenges.map((c) => ({
    challenge_id: c.id,
    service_id: c.service_id,
    client_id: c.client_id,
    nonce: c.nonce,
    scopes: c.scopes,
    service_version: Number(c.service_version || 1),
    policy_hash: getChallengePolicyHash(c),
    did_hint: c.did_hint || null,
    requested_claims: Array.isArray(c.requested_claims) ? c.requested_claims : [],
    risk_action: c.risk_action,
    expires_at: c.expires_at
  }));
  dlog(`wallet pending query did=${did} count=${pending.length}`);
  return res.json({ did, challenges: pending });
});

app.get("/v1/wallet/sessions", (req, res) => {
  const did = req.query.did;
  if (!did) {
    return res.status(400).json({ error: "did_required" });
  }

  const sessions = store.findSessionsByDid(did);
  const result = sessions.map((s) => ({
    session_id: s.id,
    service_id: s.service_id,
    subject_id: s.subject_id,
    scope: s.scope,
    requested_claims: Array.isArray(s.requested_claims) ? s.requested_claims : [],
    approved_claims: s.approved_claims || [],
    risk_level: s.risk_level,
    expires_at: s.expires_at,
    created_at: s.created_at
  }));
  dlog(`wallet sessions query did=${did} count=${result.length}`);
  return res.json({ did, sessions: result });
});

app.get("/v1/wallet/approved", (req, res) => {
  const did = req.query.did;
  if (!did) {
    return res.status(400).json({ error: "did_required" });
  }

  const authCodes = store.findApprovedAuthCodes(did);
  const approved = authCodes.map((c) => ({
    authorization_code: c.code,
    challenge_id: c.challenge_id,
    service_id: c.service_id,
    client_id: c.client_id,
    redirect_uri: c.redirect_uri,
    subject_id: c.subject_id,
    scopes: c.scopes,
    requested_claims: Array.isArray(c.requested_claims) ? c.requested_claims : [],
    approved_claims: Array.isArray(c.approved_claims) ? c.approved_claims : [],
    expires_at: c.expires_at
  }));
  dlog(`wallet approved query did=${did} count=${approved.length}`);
  return res.json({ did, approved });
});

app.delete("/v1/wallet/approved/:authCode", (req, res) => {
  const { did } = req.body || {};
  if (!did) {
    return res.status(400).json({ error: "did_required" });
  }

  const authCode = store.findAuthCodeByCode(req.params.authCode);
  if (!authCode) {
    return res.status(404).json({ error: "auth_code_not_found" });
  }
  if (authCode.did !== did) {
    return res.status(403).json({ error: "did_mismatch" });
  }
  if (authCode.used_at) {
    return res.status(409).json({ error: "already_exchanged" });
  }

  const challenge = store.findChallengeById(authCode.challenge_id);
  if (!challenge) {
    return res.status(404).json({ error: "challenge_not_found" });
  }
  if (new Date(challenge.expires_at) <= new Date()) {
    store.updateChallengeStatus(challenge.id, { status: "expired" });
    return res.status(409).json({ error: "challenge_expired_cannot_restore" });
  }

  store.updateAuthCodeUsed(authCode.code, store.nowIso());

  if (challenge.status === "verified") {
    store.updateChallengeStatus(challenge.id, {
      status: "pending",
      verified_at: null,
      authorization_code: null,
      used_at: null
    });
  }

  dlog(`approved cancelled did=${did} challenge=${challenge.id} auth_code=${authCode.code}`);
  pushWalletEvent(did, "approved_cancelled", {
    challenge_id: challenge.id,
    authorization_code: authCode.code,
    service_id: authCode.service_id
  });
  return res.json({
    challenge_id: challenge.id,
    authorization_code: authCode.code,
    status: "pending",
    restored_at: store.nowIso()
  });
});

app.delete("/v1/wallet/sessions/:sessionId", (req, res) => {
  const { did } = req.body || {};
  if (!did) {
    return res.status(400).json({ error: "did_required" });
  }

  const session = store.findSessionById(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: "session_not_found" });
  }
  if (session.did !== did) {
    return res.status(403).json({ error: "did_mismatch" });
  }
  if (session.revoked_at) {
    return res.status(409).json({ error: "already_revoked" });
  }

  const revokedAt = store.nowIso();
  store.updateSessionRevoked(session.id, revokedAt);

  dlog(`session revoked did=${did} session=${session.id}`);
  pushWalletEvent(did, "session_revoked", {
    session_id: session.id,
    service_id: session.service_id
  });
  pushServiceSessionEvent(session.service_id, "session_revoked", {
    session_id: session.id,
    service_id: session.service_id,
    subject_id: session.subject_id,
    did: session.did
  });
  return res.json({
    session_id: session.id,
    status: "revoked",
    revoked_at: revokedAt
  });
});

app.post("/v1/wallet/challenges/:challengeId/approve", async (req, res) => {
  try {
    const { did, signature, wallet_url, approved_claims } = req.body || {};
    if (!did || !signature || !wallet_url) {
      return res.status(400).json({ error: "invalid_request" });
    }

    const challenge = store.findChallengeById(req.params.challengeId);
    if (!challenge) {
      return res.status(404).json({ error: "challenge_not_found" });
    }
    if (challenge.did_hint && challenge.did_hint !== did) {
      dlog(`approve denied did mismatch challenge=${challenge.id} expected=${challenge.did_hint} got=${did}`);
      return res.status(403).json({ error: "did_mismatch" });
    }

    const respondApproved = (authCode) => res.json({
      challenge_id: challenge.id,
      status: "verified",
      authorization_code: authCode.code,
      subject_id: authCode.subject_id,
      consent_required: authCode.consent_required,
      missing_scopes: authCode.missing_scopes || [],
      approved_claims: Array.isArray(authCode.approved_claims) ? authCode.approved_claims : []
    });

    if (challenge.status === "verified") {
      const existingAuthCode = store.findLatestAuthCodeByChallengeId(challenge.id);
      if (existingAuthCode && existingAuthCode.did === did) {
        dlog(`approve idempotent hit challenge=${challenge.id} did=${did}`);
        return respondApproved(existingAuthCode);
      }
      return res.status(409).json({ error: "challenge_not_pending", status: challenge.status });
    }
    if (challenge.status !== "pending") {
      return res.status(409).json({ error: "challenge_not_pending", status: challenge.status });
    }
    if (new Date(challenge.expires_at) < new Date()) {
      store.updateChallengeStatus(challenge.id, { status: "expired" });
      return res.status(401).json({ error: "challenge_expired" });
    }

    const resolved = await resolveDidDocument({ did, walletUrl: wallet_url });
    const wallet = resolved.wallet;
    const walletProfile = normalizeWalletProfile(wallet);
    const payload = toPayloadString({
      challenge_id: challenge.id,
      nonce: challenge.nonce,
      audience: challenge.client_id,
      expires_at: challenge.expires_at
    });
    const ok = verifyWithDidDocument(resolved.didDocument, payload, signature);
    if (!ok) {
      return res.status(401).json({ error: "invalid_signature" });
    }
    const approvedClaims = normalizeRequestedClaims(approved_claims);
    const filteredProfile = filterProfileClaims(walletProfile, approvedClaims);

    const subjectId = store.findOrCreateSubject(did, challenge.service_id);
    store.upsertConsentForApproval(challenge.service_id, subjectId, challenge.scopes, "wallet_approve");
    let authCode;
    try {
      authCode = issueAuthCodeFromChallenge(challenge, did, filteredProfile, approvedClaims, wallet_url);
    } catch (err) {
      if (!String(err.message || "").includes("UNIQUE constraint failed: auth_codes.challenge_id")) {
        throw err;
      }
      const existingAuthCode = store.findLatestAuthCodeByChallengeId(challenge.id);
      if (!existingAuthCode || existingAuthCode.did !== did) {
        throw err;
      }
      dlog(`approve idempotent unique-hit challenge=${challenge.id} did=${did}`);
      return respondApproved(existingAuthCode);
    }

    dlog(`challenge approved id=${challenge.id} did=${did} auth_code=${authCode.code}`);
    pushChallengeEvent(challenge.id, "challenge_verified", {
      challenge_id: challenge.id,
      authorization_code: authCode.code,
      service_id: challenge.service_id,
      client_id: challenge.client_id,
      redirect_uri: challenge.redirect_uri,
      status: "verified"
    });
    pushWalletEvent(did, "challenge_approved", {
      challenge_id: challenge.id,
      authorization_code: authCode.code,
      service_id: challenge.service_id
    });
    return respondApproved(authCode);
  } catch (err) {
    return res.status(500).json({ error: "approve_failed", message: err.message });
  }
});

app.post("/v1/wallet/challenges/:challengeId/deny", (req, res) => {
  const { did } = req.body || {};
  if (!did) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const challenge = store.findChallengeById(req.params.challengeId);
  if (!challenge) {
    return res.status(404).json({ error: "challenge_not_found" });
  }
  if (challenge.did_hint && challenge.did_hint !== did) {
    dlog(`deny rejected did mismatch challenge=${challenge.id} expected=${challenge.did_hint} got=${did}`);
    return res.status(403).json({ error: "did_mismatch" });
  }
  if (challenge.status !== "pending") {
    return res.status(409).json({ error: "challenge_not_pending", status: challenge.status });
  }

  const deniedAt = store.nowIso();
  store.updateChallengeStatus(challenge.id, { status: "denied", denied_at: deniedAt });

  dlog(`challenge denied id=${challenge.id} did=${did}`);
  pushChallengeEvent(challenge.id, "challenge_denied", { challenge_id: challenge.id, service_id: challenge.service_id });
  pushWalletEvent(did, "challenge_denied", { challenge_id: challenge.id, service_id: challenge.service_id });
  return res.json({ challenge_id: challenge.id, status: "denied", denied_at: deniedAt });
});

app.post("/v1/token/exchange", (req, res) => {
  const service = authenticateServiceClient(req, res);
  if (!service) {
    return;
  }
  const { grant_type, code, client_id, redirect_uri } = req.body || {};
  if (grant_type !== "authorization_code" || !code || !client_id || !redirect_uri) {
    return res.status(400).json({ error: "invalid_request" });
  }
  if (client_id !== service.client_id) {
    return res.status(403).json({ error: "client_id_mismatch" });
  }
  if (!service.redirect_uris.includes(redirect_uri)) {
    return res.status(403).json({ error: "redirect_uri_not_allowed" });
  }
  dlog(`token exchange attempt code=${code} client=${client_id}`);

  const authCode = store.findAuthCodeByCode(code);
  if (!authCode) {
    return res.status(400).json({ error: "invalid_code" });
  }
  if (authCode.used_at) {
    return res.status(409).json({ error: "code_already_used" });
  }
  if (new Date(authCode.expires_at) < new Date()) {
    return res.status(401).json({ error: "code_expired" });
  }
  if (
    authCode.client_id !== client_id ||
    authCode.redirect_uri !== redirect_uri ||
    authCode.service_id !== service.service_id
  ) {
    return res.status(401).json({ error: "client_or_redirect_mismatch" });
  }

  try {
    if (!WALLET_AUTHORITATIVE_MODE && authCode.consent_required) {
      const activeConsents = store.findActiveConsents(authCode.service_id, authCode.subject_id);
      const latestConsent = activeConsents[0];
      if (!latestConsent || !hasAllScopes(latestConsent.scopes, authCode.scopes)) {
        return res.status(403).json({
          error: "consent_required",
          missing_scopes: authCode.missing_scopes
        });
      }
    }

    const riskLevel = authCode.risk_action ? "step_up" : "normal";
    const scopeStr = [...new Set(authCode.scopes)].sort().join(" ");
    const sessionPatch = {
      subject_id: authCode.subject_id,
      requested_claims: authCode.requested_claims || [],
      approved_claims: authCode.approved_claims || [],
      profile_claims: authCode.profile_claims || { name: null, email: null, nickname: null },
      wallet_url: authCode.wallet_url || null,
      risk_level: riskLevel,
      access_token: `at_${store.randomToken(24)}`,
      refresh_token: `rt_${store.randomToken(24)}`,
      scope: scopeStr,
      expires_at: store.addMinutes(store.nowIso(), riskLevel === "step_up" ? 10 : 60),
      created_at: store.nowIso()
    };

    let targetSession = store.findActiveSessionByDidService(authCode.service_id, authCode.did);
    if (targetSession) {
      store.updateSessionForTokenExchange(targetSession.id, sessionPatch);
      targetSession = store.findSessionById(targetSession.id);
    } else {
      const newSession = {
        id: crypto.randomUUID(),
        service_id: authCode.service_id,
        subject_id: authCode.subject_id,
        did: authCode.did,
        requested_claims: sessionPatch.requested_claims,
        approved_claims: sessionPatch.approved_claims,
        profile_claims: sessionPatch.profile_claims,
        wallet_url: sessionPatch.wallet_url,
        risk_level: sessionPatch.risk_level,
        access_token: sessionPatch.access_token,
        refresh_token: sessionPatch.refresh_token,
        scope: sessionPatch.scope,
        expires_at: sessionPatch.expires_at,
        created_at: sessionPatch.created_at
      };
      const inserted = store.insertSessionOrIgnore(newSession);
      if (inserted) {
        targetSession = newSession;
      } else {
        const concurrent = store.findActiveSessionByDidService(authCode.service_id, authCode.did);
        if (!concurrent) {
          throw new Error("session_upsert_failed");
        }
        store.updateSessionForTokenExchange(concurrent.id, sessionPatch);
        targetSession = store.findSessionById(concurrent.id);
      }
    }

    store.updateAuthCodeUsed(code, store.nowIso());
    const revokedOthers = store.revokeOtherActiveSessionsByDidService(targetSession.service_id, targetSession.did, targetSession.id);
    revokedOthers.forEach((revoked) => {
      pushWalletEvent(revoked.did, "session_revoked", {
        session_id: revoked.id,
        service_id: revoked.service_id
      });
      pushServiceSessionEvent(revoked.service_id, "session_revoked", {
        session_id: revoked.id,
        service_id: revoked.service_id,
        subject_id: revoked.subject_id,
        did: revoked.did
      });
    });

    pushWalletEvent(targetSession.did, "session_created", {
      session_id: targetSession.id,
      service_id: targetSession.service_id,
      scope: targetSession.scope,
      expires_at: targetSession.expires_at,
      reused: true
    });
    pushServiceSessionEvent(targetSession.service_id, "session_created", {
      session_id: targetSession.id,
      service_id: targetSession.service_id,
      subject_id: targetSession.subject_id,
      did: targetSession.did,
      scope: targetSession.scope,
      expires_at: targetSession.expires_at,
      reused: true
    });

    dlog(`token exchange success code=${code} session=${targetSession.id} did=${targetSession.did}`);
    const expiresIn = Math.max(1, Math.floor((new Date(targetSession.expires_at).getTime() - Date.now()) / 1000));
    return res.json({
      session_id: targetSession.id,
      access_token: targetSession.access_token,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: targetSession.refresh_token,
      id_token: `id_${store.randomToken(24)}`,
      scope: targetSession.scope
    });
  } catch (err) {
    dlog(`token exchange failed code=${code} err=${err.message}`);
    return res.status(500).json({ error: "token_exchange_failed", message: err.message });
  }
});

app.post("/v1/consents", (req, res) => {
  const { service_id, subject_id, scopes, purpose, ttl_days } = req.body || {};
  if (!service_id || !subject_id || !Array.isArray(scopes) || scopes.length === 0 || !purpose) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const normalizedScopes = [...new Set(scopes)];
  const version = store.getMaxConsentVersion(service_id, subject_id) + 1;

  const consent = {
    id: crypto.randomUUID(),
    service_id,
    subject_id,
    scopes: normalizedScopes,
    scope_hash: store.hashScopes(normalizedScopes),
    purpose,
    version,
    status: "active",
    granted_at: store.nowIso(),
    expires_at: ttl_days ? store.addDays(store.nowIso(), Number(ttl_days)) : null
  };

  store.insertConsent(consent);

  return res.json({
    consent_id: consent.id,
    service_id: consent.service_id,
    subject_id: consent.subject_id,
    scopes: consent.scopes,
    version: consent.version,
    status: consent.status,
    granted_at: consent.granted_at,
    expires_at: consent.expires_at,
    revoked_at: null
  });
});

app.get("/v1/consents/:consentId", (req, res) => {
  const consent = store.findConsentById(req.params.consentId);
  if (!consent) {
    return res.status(404).json({ error: "consent_not_found" });
  }
  return res.json({
    consent_id: consent.id,
    service_id: consent.service_id,
    subject_id: consent.subject_id,
    scopes: consent.scopes,
    version: consent.version,
    status: consent.status,
    granted_at: consent.granted_at,
    expires_at: consent.expires_at,
    revoked_at: consent.revoked_at
  });
});

app.delete("/v1/consents/:consentId", (req, res) => {
  const consent = store.findConsentById(req.params.consentId);
  if (!consent) {
    return res.status(404).json({ error: "consent_not_found" });
  }

  const revokedAt = store.nowIso();
  store.updateConsentRevoked(consent.id, revokedAt);

  const revokedSessions = store.revokeSessionsByConsent(consent.service_id, consent.subject_id);
  revokedSessions.forEach((s) => {
    pushWalletEvent(s.did, "session_revoked", {
      session_id: s.id,
      service_id: consent.service_id
    });
    pushServiceSessionEvent(consent.service_id, "session_revoked", {
      session_id: s.id,
      service_id: consent.service_id,
      subject_id: consent.subject_id,
      did: s.did
    });
  });

  return res.json({ consent_id: consent.id, status: "revoked", revoked_at: revokedAt });
});

app.get("/v1/services/:serviceId/profile", requireBearer, (req, res) => {
  const session = store.findSessionByAccessToken(req.accessToken);
  if (!session) {
    return res.status(401).json({ error: "invalid_token" });
  }
  if (session.revoked_at || new Date(session.expires_at) < new Date()) {
    return res.status(401).json({ error: "token_expired_or_revoked" });
  }
  if (session.service_id !== req.params.serviceId) {
    return res.status(403).json({ error: "service_mismatch" });
  }

  const approvedSet = new Set(Array.isArray(session.approved_claims) ? session.approved_claims : []);
  const profileResponse = {
    service_id: session.service_id,
    subject_id: session.subject_id,
    did: session.did,
    scope: session.scope,
    requested_claims: Array.isArray(session.requested_claims) ? session.requested_claims : [],
    approved_claims: Array.isArray(session.approved_claims) ? session.approved_claims : [],
    risk_level: session.risk_level
  };

  if (session.profile_claims) {
    Object.entries(session.profile_claims).forEach(([key, value]) => {
      if (approvedSet.has(key)) {
        profileResponse[key] = value;
      }
    });
  }

  return res.json(profileResponse);
});

app.use((err, _req, res, _next) => {
  dlog(`unhandled error: ${err?.message || err}`);
  return res.status(500).json({
    error: "internal_server_error",
    message: err?.message || "unknown_error"
  });
});

// Initialize database and start server
const db = getDb();
initializeSchema(db);
startCleanupScheduler();
loadServiceRegistry();

app.listen(PORT, () => {
  console.log(`gateway listening on http://localhost:${PORT} debug=${DEBUG_AUTH ? "on" : "off"}`);
});
