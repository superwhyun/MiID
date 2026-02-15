const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.GATEWAY_PORT || 14000;
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DATA_FILE = path.join(DATA_DIR, "gateway.json");
const DEBUG_AUTH = process.env.DEBUG_AUTH === "1";
const SERVICE_REGISTRY = parseServiceRegistry();

function dlog(message) {
  if (DEBUG_AUTH) {
    console.log(`[gateway] ${message}`);
  }
}

function parseServiceRegistry() {
  const clientId = process.env.SERVICE_CLIENT_ID || "web-client";
  const serviceId = process.env.SERVICE_ID || "service-test";
  const clientSecret = process.env.SERVICE_CLIENT_SECRET || "dev-service-secret";
  const redirectUri = process.env.SERVICE_REDIRECT_URI || "https://service-test.local/callback";
  return new Map([
    [
      clientId,
      {
        client_id: clientId,
        service_id: serviceId,
        client_secret: clientSecret,
        redirect_uris: [redirectUri]
      }
    ]
  ]);
}

function authenticateServiceClient(req, res) {
  const clientId = req.headers["x-client-id"];
  const clientSecret = req.headers["x-client-secret"];
  if (!clientId || !clientSecret) {
    res.status(401).json({ error: "service_client_auth_required" });
    return null;
  }
  const service = SERVICE_REGISTRY.get(clientId);
  if (!service || service.client_secret !== clientSecret) {
    res.status(401).json({ error: "invalid_service_client_credentials" });
    return null;
  }
  return service;
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    const initial = {
      challenges: [],
      authCodes: [],
      subjects: [],
      consents: [],
      sessions: []
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeStore(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function addMinutes(date, minutes) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function toPayloadString(payload) {
  return JSON.stringify(payload);
}

function hashScopes(scopes) {
  const normalized = [...new Set(scopes)].sort().join(" ");
  return crypto.createHash("sha256").update(normalized).digest("hex");
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

function findOrCreateSubject(store, did, serviceId) {
  let row = store.subjects.find((s) => s.did === did && s.service_id === serviceId);
  if (row) {
    return row.subject_id;
  }
  const subjectId = `sub_${crypto.randomUUID().replace(/-/g, "")}`;
  row = { id: crypto.randomUUID(), did, service_id: serviceId, subject_id: subjectId, created_at: nowIso() };
  store.subjects.push(row);
  return subjectId;
}

function verifyWalletSignature(publicKeyPem, payload, signatureBase64Url) {
  return crypto.verify(
    null,
    Buffer.from(payload),
    publicKeyPem,
    Buffer.from(signatureBase64Url, "base64url")
  );
}

async function fetchWalletPublicKey(walletUrl, did) {
  const res = await fetch(`${walletUrl}/v1/wallets/by-did/${encodeURIComponent(did)}`);
  if (!res.ok) {
    throw new Error(`wallet did lookup failed: ${res.status}`);
  }
  return res.json();
}

function issueAuthCodeFromChallenge(store, challenge, did) {
  const subjectId = findOrCreateSubject(store, did, challenge.service_id);
  const activeConsents = store.consents
    .filter((c) => c.service_id === challenge.service_id && c.subject_id === subjectId && c.status === "active")
    .sort((a, b) => b.version - a.version);
  const latestConsent = activeConsents[0];
  const missing = latestConsent
    ? challenge.scopes.filter((s) => !latestConsent.scopes.includes(s))
    : challenge.scopes;

  const authCode = {
    id: crypto.randomUUID(),
    code: `ac_${randomToken(16)}`,
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
    expires_at: addMinutes(nowIso(), 2),
    used_at: null,
    created_at: nowIso()
  };

  challenge.used_at = nowIso();
  challenge.status = "verified";
  challenge.verified_at = nowIso();
  challenge.authorization_code = authCode.code;
  store.authCodes.push(authCode);

  return authCode;
}

function upsertConsentForApproval(store, serviceId, subjectId, scopes, purpose = "wallet_approval") {
  const normalizedScopes = [...new Set(scopes)];
  const versions = store.consents
    .filter((c) => c.service_id === serviceId && c.subject_id === subjectId)
    .map((c) => c.version);
  const version = (versions.length ? Math.max(...versions) : 0) + 1;

  const consent = {
    id: crypto.randomUUID(),
    service_id: serviceId,
    subject_id: subjectId,
    scopes: normalizedScopes,
    scope_hash: hashScopes(normalizedScopes),
    purpose,
    version,
    status: "active",
    granted_at: nowIso(),
    expires_at: null,
    revoked_at: null
  };
  store.consents.push(consent);
  return consent;
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
  const body = JSON.stringify({ type, payload, at: nowIso() });
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
    return;
  }
  const body = JSON.stringify({ type, payload, at: nowIso() });
  current.forEach((res) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${body}\n\n`);
  });
}

function broadcastWalletEvent(type, payload) {
  const body = JSON.stringify({ type, payload, at: nowIso() });
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
  const body = JSON.stringify({ type, payload, at: nowIso() });
  current.forEach((res) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${body}\n\n`);
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "gateway", now: nowIso() });
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
  res.write(`data: ${JSON.stringify({ did, at: nowIso() })}\n\n`);
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

  const store = readStore();
  const challenge = store.challenges.find((c) => c.id === challengeId);
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
  dlog(`service events connected challenge_id=${challengeId}`);
  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({ challenge_id: challengeId, at: nowIso() })}\n\n`);

  addChallengeStream(challengeId, res);
  const keepAlive = setInterval(() => {
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
  res.write(`data: ${JSON.stringify({ service_id: serviceId, at: nowIso() })}\n\n`);
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
  const { service_id, client_id, redirect_uri, scopes, state, risk_action, did_hint, require_user_approval } = req.body || {};
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

  const store = readStore();
  const challenge = {
    id: crypto.randomUUID(),
    nonce: randomToken(18),
    service_id: service.service_id,
    client_id: service.client_id,
    redirect_uri,
    scopes: [...new Set(scopes)],
    state: state || null,
    risk_action: risk_action || null,
    did_hint: did_hint || null,
    require_user_approval: require_user_approval !== false,
    status: "pending",
    verified_at: null,
    denied_at: null,
    authorization_code: null,
    expires_at: addMinutes(nowIso(), 5),
    used_at: null,
    created_at: nowIso()
  };
  store.challenges.push(challenge);
  dlog(`challenge created id=${challenge.id} did_hint=${challenge.did_hint || "none"} service=${challenge.service_id}`);
  writeStore(store);
  const eventPayload = {
    challenge_id: challenge.id,
    service_id: challenge.service_id,
    scopes: challenge.scopes,
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
    status: challenge.status
  });
});

app.post("/v1/auth/reuse-session", (req, res) => {
  const service = authenticateServiceClient(req, res);
  if (!service) {
    return;
  }
  const { did, scopes } = req.body || {};
  if (!did || !Array.isArray(scopes) || scopes.length === 0) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const store = readStore();
  const reusable = store.sessions.find(
    (s) =>
      s.service_id === service.service_id &&
      s.did === did &&
      !s.revoked_at &&
      new Date(s.expires_at) > new Date() &&
      hasAllScopes(parseScopeText(s.scope), scopes)
  );
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
    at: nowIso()
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

    const store = readStore();
    const challenge = store.challenges.find((c) => c.id === challenge_id);
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

    const wallet = await fetchWalletPublicKey(wallet_url, did);
    const payload = toPayloadString({
      challenge_id: challenge.id,
      nonce: challenge.nonce,
      audience: challenge.client_id,
      expires_at: challenge.expires_at
    });
    const ok = verifyWalletSignature(wallet.public_key_pem, payload, signature);
    if (!ok) {
      return res.status(401).json({ error: "invalid_signature" });
    }

    const authCode = issueAuthCodeFromChallenge(store, challenge, did);
    writeStore(store);

    return res.json({
      authorization_code: authCode.code,
      code_expires_at: authCode.expires_at,
      subject_id: authCode.subject_id,
      consent_required: authCode.consent_required,
      missing_scopes: authCode.missing_scopes
    });
  } catch (err) {
    return res.status(500).json({ error: "verify_failed", message: err.message });
  }
});

app.get("/v1/auth/challenges/:challengeId/status", (req, res) => {
  const store = readStore();
  const challenge = store.challenges.find((c) => c.id === req.params.challengeId);
  if (!challenge) {
    return res.status(404).json({ error: "challenge_not_found" });
  }
  if (new Date(challenge.expires_at) < new Date() && challenge.status === "pending") {
    challenge.status = "expired";
    writeStore(store);
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
  const store = readStore();
  const pending = store.challenges
    .filter((c) => (c.did_hint === did || c.did_hint === null) && c.status === "pending" && new Date(c.expires_at) > new Date())
    .map((c) => ({
      challenge_id: c.id,
      service_id: c.service_id,
      client_id: c.client_id,
      nonce: c.nonce,
      scopes: c.scopes,
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
  const store = readStore();
  const sessions = store.sessions
    .filter((s) => s.did === did && !s.revoked_at && new Date(s.expires_at) > new Date())
    .map((s) => ({
      session_id: s.id,
      service_id: s.service_id,
      subject_id: s.subject_id,
      scope: s.scope,
      risk_level: s.risk_level,
      expires_at: s.expires_at,
      created_at: s.created_at
    }));
  dlog(`wallet sessions query did=${did} count=${sessions.length}`);
  return res.json({ did, sessions });
});

app.get("/v1/wallet/approved", (req, res) => {
  const did = req.query.did;
  if (!did) {
    return res.status(400).json({ error: "did_required" });
  }
  const store = readStore();
  const approved = store.authCodes
    .filter((c) => c.did === did && !c.used_at && new Date(c.expires_at) > new Date())
    .map((c) => ({
      authorization_code: c.code,
      challenge_id: c.challenge_id,
      service_id: c.service_id,
      client_id: c.client_id,
      redirect_uri: c.redirect_uri,
      subject_id: c.subject_id,
      scopes: c.scopes,
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

  const store = readStore();
  const authCode = store.authCodes.find((c) => c.code === req.params.authCode);
  if (!authCode) {
    return res.status(404).json({ error: "auth_code_not_found" });
  }
  if (authCode.did !== did) {
    return res.status(403).json({ error: "did_mismatch" });
  }
  if (authCode.used_at) {
    return res.status(409).json({ error: "already_exchanged" });
  }

  const challenge = store.challenges.find((c) => c.id === authCode.challenge_id);
  if (!challenge) {
    return res.status(404).json({ error: "challenge_not_found" });
  }
  if (new Date(challenge.expires_at) <= new Date()) {
    challenge.status = "expired";
    writeStore(store);
    return res.status(409).json({ error: "challenge_expired_cannot_restore" });
  }

  authCode.used_at = nowIso();
  if (challenge.status === "verified") {
    challenge.status = "pending";
    challenge.verified_at = null;
    challenge.authorization_code = null;
    challenge.used_at = null;
  }
  writeStore(store);
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
    restored_at: nowIso()
  });
});

app.delete("/v1/wallet/sessions/:sessionId", (req, res) => {
  const { did } = req.body || {};
  if (!did) {
    return res.status(400).json({ error: "did_required" });
  }

  const store = readStore();
  const session = store.sessions.find((s) => s.id === req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: "session_not_found" });
  }
  if (session.did !== did) {
    return res.status(403).json({ error: "did_mismatch" });
  }
  if (session.revoked_at) {
    return res.status(409).json({ error: "already_revoked" });
  }

  session.revoked_at = nowIso();
  writeStore(store);
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
    revoked_at: session.revoked_at
  });
});

app.post("/v1/wallet/challenges/:challengeId/approve", async (req, res) => {
  try {
    const { did, signature, wallet_url } = req.body || {};
    if (!did || !signature || !wallet_url) {
      return res.status(400).json({ error: "invalid_request" });
    }

    const store = readStore();
    const challenge = store.challenges.find((c) => c.id === req.params.challengeId);
    if (!challenge) {
      return res.status(404).json({ error: "challenge_not_found" });
    }
    if (challenge.status !== "pending") {
      return res.status(409).json({ error: "challenge_not_pending", status: challenge.status });
    }
    if (challenge.did_hint && challenge.did_hint !== did) {
      dlog(`approve denied did mismatch challenge=${challenge.id} expected=${challenge.did_hint} got=${did}`);
      return res.status(403).json({ error: "did_mismatch" });
    }
    if (new Date(challenge.expires_at) < new Date()) {
      challenge.status = "expired";
      writeStore(store);
      return res.status(401).json({ error: "challenge_expired" });
    }

    const wallet = await fetchWalletPublicKey(wallet_url, did);
    const payload = toPayloadString({
      challenge_id: challenge.id,
      nonce: challenge.nonce,
      audience: challenge.client_id,
      expires_at: challenge.expires_at
    });
    const ok = verifyWalletSignature(wallet.public_key_pem, payload, signature);
    if (!ok) {
      return res.status(401).json({ error: "invalid_signature" });
    }

    const subjectId = findOrCreateSubject(store, did, challenge.service_id);
    upsertConsentForApproval(store, challenge.service_id, subjectId, challenge.scopes, "wallet_approve");
    const authCode = issueAuthCodeFromChallenge(store, challenge, did);
    writeStore(store);
    dlog(`challenge approved id=${challenge.id} did=${did} auth_code=${authCode.code}`);
    pushChallengeEvent(challenge.id, "challenge_verified", {
      challenge_id: challenge.id,
      authorization_code: authCode.code,
      service_id: challenge.service_id,
      client_id: challenge.client_id,
      redirect_uri: challenge.redirect_uri,
      status: challenge.status
    });
    pushWalletEvent(did, "challenge_approved", {
      challenge_id: challenge.id,
      authorization_code: authCode.code,
      service_id: challenge.service_id
    });
    return res.json({
      challenge_id: challenge.id,
      status: challenge.status,
      authorization_code: authCode.code,
      subject_id: authCode.subject_id,
      consent_required: authCode.consent_required,
      missing_scopes: authCode.missing_scopes
    });
  } catch (err) {
    return res.status(500).json({ error: "approve_failed", message: err.message });
  }
});

app.post("/v1/wallet/challenges/:challengeId/deny", (req, res) => {
  const { did } = req.body || {};
  if (!did) {
    return res.status(400).json({ error: "invalid_request" });
  }
  const store = readStore();
  const challenge = store.challenges.find((c) => c.id === req.params.challengeId);
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
  challenge.status = "denied";
  challenge.denied_at = nowIso();
  writeStore(store);
  dlog(`challenge denied id=${challenge.id} did=${did}`);
  pushChallengeEvent(challenge.id, "challenge_denied", { challenge_id: challenge.id, service_id: challenge.service_id });
  pushWalletEvent(did, "challenge_denied", { challenge_id: challenge.id, service_id: challenge.service_id });
  return res.json({ challenge_id: challenge.id, status: challenge.status, denied_at: challenge.denied_at });
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

  const store = readStore();
  const authCode = store.authCodes.find((c) => c.code === code);
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

  if (authCode.consent_required) {
    const activeConsents = store.consents
      .filter((c) => c.service_id === authCode.service_id && c.subject_id === authCode.subject_id && c.status === "active")
      .sort((a, b) => b.version - a.version);
    const latestConsent = activeConsents[0];
    if (!latestConsent || !hasAllScopes(latestConsent.scopes, authCode.scopes)) {
      return res.status(403).json({
        error: "consent_required",
        missing_scopes: authCode.missing_scopes
      });
    }
  }

  const riskLevel = authCode.risk_action ? "step_up" : "normal";
  const existingSession = store.sessions.find(
    (s) =>
      s.service_id === authCode.service_id &&
      s.subject_id === authCode.subject_id &&
      s.scope === authCode.scopes.join(" ") &&
      s.risk_level === riskLevel &&
      !s.revoked_at &&
      new Date(s.expires_at) > new Date()
  );

  if (existingSession) {
    authCode.used_at = nowIso();
    writeStore(store);
    dlog(`token exchange reused session code=${code} session=${existingSession.id} did=${existingSession.did}`);
    const expiresIn = Math.max(1, Math.floor((new Date(existingSession.expires_at).getTime() - Date.now()) / 1000));
    return res.json({
      session_id: existingSession.id,
      access_token: existingSession.access_token,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: existingSession.refresh_token,
      id_token: `id_${randomToken(24)}`,
      scope: existingSession.scope
    });
  }

  const accessToken = `at_${randomToken(24)}`;
  const refreshToken = `rt_${randomToken(24)}`;

  const session = {
    id: crypto.randomUUID(),
    service_id: authCode.service_id,
    subject_id: authCode.subject_id,
    did: authCode.did,
    risk_level: riskLevel,
    access_token: accessToken,
    refresh_token: refreshToken,
    scope: authCode.scopes.join(" "),
    expires_at: addMinutes(nowIso(), riskLevel === "step_up" ? 10 : 60),
    revoked_at: null,
    created_at: nowIso()
  };
  authCode.used_at = nowIso();
  store.sessions.push(session);
  writeStore(store);
  dlog(`token exchange success code=${code} session=${session.id} did=${session.did}`);
  pushWalletEvent(session.did, "session_created", {
    session_id: session.id,
    service_id: session.service_id,
    scope: session.scope,
    expires_at: session.expires_at
  });
  pushServiceSessionEvent(session.service_id, "session_created", {
    session_id: session.id,
    service_id: session.service_id,
    subject_id: session.subject_id,
    did: session.did,
    scope: session.scope,
    expires_at: session.expires_at
  });

  return res.json({
    session_id: session.id,
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: riskLevel === "step_up" ? 600 : 3600,
    refresh_token: refreshToken,
    id_token: `id_${randomToken(24)}`,
    scope: session.scope
  });
});

app.post("/v1/consents", (req, res) => {
  const { service_id, subject_id, scopes, purpose, ttl_days } = req.body || {};
  if (!service_id || !subject_id || !Array.isArray(scopes) || scopes.length === 0 || !purpose) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const store = readStore();
  const normalizedScopes = [...new Set(scopes)];
  const versions = store.consents
    .filter((c) => c.service_id === service_id && c.subject_id === subject_id)
    .map((c) => c.version);
  const version = (versions.length ? Math.max(...versions) : 0) + 1;

  const consent = {
    id: crypto.randomUUID(),
    service_id,
    subject_id,
    scopes: normalizedScopes,
    scope_hash: hashScopes(normalizedScopes),
    purpose,
    version,
    status: "active",
    granted_at: nowIso(),
    expires_at: ttl_days ? addDays(nowIso(), Number(ttl_days)) : null,
    revoked_at: null
  };
  store.consents.push(consent);
  writeStore(store);

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

app.get("/v1/consents/:consentId", (req, res) => {
  const store = readStore();
  const consent = store.consents.find((c) => c.id === req.params.consentId);
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
  const store = readStore();
  const consent = store.consents.find((c) => c.id === req.params.consentId);
  if (!consent) {
    return res.status(404).json({ error: "consent_not_found" });
  }

  consent.status = "revoked";
  consent.revoked_at = nowIso();
  store.sessions
    .filter((s) => s.service_id === consent.service_id && s.subject_id === consent.subject_id && !s.revoked_at)
    .forEach((s) => {
      s.revoked_at = nowIso();
      pushWalletEvent(s.did, "session_revoked", {
        session_id: s.id,
        service_id: s.service_id
      });
      pushServiceSessionEvent(s.service_id, "session_revoked", {
        session_id: s.id,
        service_id: s.service_id,
        subject_id: s.subject_id,
        did: s.did
      });
    });
  writeStore(store);
  return res.json({ consent_id: consent.id, status: "revoked", revoked_at: consent.revoked_at });
});

app.get("/v1/services/:serviceId/profile", requireBearer, (req, res) => {
  const store = readStore();
  const session = store.sessions.find((s) => s.access_token === req.accessToken);
  if (!session) {
    return res.status(401).json({ error: "invalid_token" });
  }
  if (session.revoked_at || new Date(session.expires_at) < new Date()) {
    return res.status(401).json({ error: "token_expired_or_revoked" });
  }
  if (session.service_id !== req.params.serviceId) {
    return res.status(403).json({ error: "service_mismatch" });
  }
  return res.json({
    service_id: session.service_id,
    subject_id: session.subject_id,
    did: session.did,
    scope: session.scope,
    risk_level: session.risk_level
  });
});

app.listen(PORT, () => {
  console.log(`gateway listening on http://localhost:${PORT} debug=${DEBUG_AUTH ? "on" : "off"}`);
});
