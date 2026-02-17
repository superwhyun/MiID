const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { EventSource } = require("eventsource");

const PORT = Number(process.env.PORT || 15000);
const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:14000";
const LOCAL_WALLET_URL = process.env.LOCAL_WALLET_URL || process.env.WALLET_URL || "http://127.0.0.1:17000";
const LOCAL_WALLET_REQUIRED = process.env.LOCAL_WALLET_REQUIRED !== "0";
const LOCAL_WALLET_HEALTH_TIMEOUT_MS = Number(process.env.LOCAL_WALLET_HEALTH_TIMEOUT_MS || 1200);
const SERVICE_ID = process.env.SERVICE_ID || "service-test";
const CLIENT_ID = process.env.CLIENT_ID || process.env.SERVICE_CLIENT_ID || "web-client";
const CLIENT_SECRET = process.env.CLIENT_SECRET || process.env.SERVICE_CLIENT_SECRET || "dev-service-secret";
const REDIRECT_URI = process.env.REDIRECT_URI || process.env.SERVICE_REDIRECT_URI || "https://service-test.local/callback";
const SESSION_MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_MS || 3600000);
const AUTO_FINALIZE = process.env.SERVICE_AUTO_FINALIZE !== "0";
const DEBUG_AUTH = process.env.DEBUG_AUTH === "1";
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const CONFIGS_FILE = path.join(DATA_DIR, "service-configs.json");

let CURRENT_SERVICE_ID = process.env.SERVICE_ID || "service-test";
let CURRENT_CLIENT_ID = process.env.CLIENT_ID || process.env.SERVICE_CLIENT_ID || "web-client";
let DYNAMIC_REQUESTED_CLAIMS = (process.env.REQUESTED_CLAIMS || "name,email,nickname")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const sessions = new Map();
const gatewaySessionToLocalSid = new Map();
const challengeStates = new Map();
const challengeClients = new Map();
const gatewayStreams = new Map();
const sessionClients = new Map();
const serviceConfigs = new Map();

const defaultServiceId = SERVICE_ID;
// Initialized via loadConfigs()

const gatewaySessionEventSources = new Map(); // client_id -> EventSource

// --- Storage ---

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadConfigs() {
  ensureStore();
  let configs = [];
  try {
    if (fs.existsSync(CONFIGS_FILE)) {
      configs = JSON.parse(fs.readFileSync(CONFIGS_FILE, "utf8"));
    }
  } catch (err) {
    dlog(`Failed to read configs file: ${err.message}`);
  }

  // Restore Map
  configs.forEach((c) => {
    serviceConfigs.set(c.service_id, c);
  });

  // Ensure default service is there
  if (!serviceConfigs.has(defaultServiceId)) {
    const defaultCfg = {
      service_id: defaultServiceId,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      requested_claims: DYNAMIC_REQUESTED_CLAIMS,
      service_name: "Default Service",
      registered: true
    };
    serviceConfigs.set(defaultServiceId, defaultCfg);
    saveConfigs();
  }
}

function saveConfigs() {
  ensureStore();
  const list = Array.from(serviceConfigs.values());
  try {
    fs.writeFileSync(CONFIGS_FILE, JSON.stringify(list, null, 2));
  } catch (err) {
    dlog(`Failed to save configs: ${err.message}`);
  }
}

function dlog(message) {
  if (DEBUG_AUTH) {
    console.log(`[service-backend] ${message}`);
  }
}

function generateSessionId() {
  return `sid_${crypto.randomBytes(24).toString("base64url")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function createSession(serviceId, userData) {
  const sid = generateSessionId();
  const session = {
    sid,
    service_id: serviceId,
    ...userData,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString()
  };
  sessions.set(sid, session);
  if (session.gatewaySessionId) {
    gatewaySessionToLocalSid.set(session.gatewaySessionId, sid);
  }
  return session;
}

function getSession(req, serviceId) {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[`sid_${serviceId}`] || cookies.sid; // fallback to generic
  if (!sid) return null;

  const session = sessions.get(sid);
  if (!session) return null;
  if (new Date(session.expiresAt) < new Date()) {
    sessions.delete(sid);
    return null;
  }
  // Optional security check: if providing serviceId, ensure session matches
  if (serviceId && session.service_id !== serviceId) return null;
  return session;
}

function deleteSession(sid) {
  const current = sessions.get(sid);
  if (current && current.gatewaySessionId) {
    gatewaySessionToLocalSid.delete(current.gatewaySessionId);
  }
  sessions.delete(sid);
}

function startGatewaySessionEventStream(clientId) {
  if (gatewaySessionEventSources.has(clientId)) {
    return;
  }

  const config = Array.from(serviceConfigs.values()).find(s => s.client_id === clientId);
  if (!config || !config.registered) return;

  const es = new EventSource(`${GATEWAY_URL}/v1/service/session-events`, {
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        headers: {
          ...(init?.headers || {}),
          "X-Client-Id": config.client_id,
          "X-Client-Secret": config.client_secret
        }
      })
  });
  gatewaySessionEventSources.set(clientId, es);
  dlog(`gateway session stream open for client=${clientId}`);

  const handleRevoke = (event) => {
    try {
      const data = JSON.parse(event.data);
      dlog(`handleRevoke event received: ${event.type} payload=${JSON.stringify(data.payload || data)}`);
      const gatewaySessionId = data.payload?.session_id || data.session_id;
      if (!gatewaySessionId) return;

      const sid = gatewaySessionToLocalSid.get(gatewaySessionId);
      if (!sid) {
        dlog(`handleRevoke: no local sid found for gatewaySessionId=${gatewaySessionId}`);
        return;
      }

      const session = sessions.get(sid);
      if (!session) {
        dlog(`handleRevoke: session record missing for sid=${sid}`);
        return;
      }
      const serviceId = session.service_id;

      deleteSession(sid);
      emitSessionEvent(sid, "force_logout", {
        reason: "revoked",
        service_id: serviceId,
        event: event.type,
        session_id: gatewaySessionId
      });
      dlog(`force logout SUCCESS sid=${sid} service=${serviceId} gateway_session=${gatewaySessionId} event=${event.type}`);
    } catch (err) {
      dlog(`session stream parse error: ${err.message}`);
    }
  };

  es.addEventListener("session_revoked", handleRevoke);
  es.addEventListener("session_terminated", handleRevoke);
  es.addEventListener("session_deleted", handleRevoke);

  es.onopen = () => {
    dlog(`gateway session stream connected client=${clientId}`);
  };

  es.onerror = (err) => {
    dlog(`gateway session stream error client=${clientId}: ${err.message || "unknown"}`);
  };
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach((cookie) => {
    const parts = cookie.split("=");
    const key = parts[0].trim();
    const value = parts.slice(1).join("=").trim();
    if (key) cookies[key] = value;
  });
  return cookies;
}

function emitChallengeEvent(challengeId, type, payload) {
  const subs = challengeClients.get(challengeId);
  if (!subs) {
    return;
  }
  const body = JSON.stringify({ type, payload, at: nowIso() });
  subs.forEach((res) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${body}\n\n`);
  });
  dlog(`emit challenge event challenge=${challengeId} type=${type}`);
}

function emitSessionEvent(sid, type, payload) {
  const subs = sessionClients.get(sid);
  if (!subs) {
    return;
  }
  const body = JSON.stringify({ type, payload, at: nowIso() });
  subs.forEach((res) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${body}\n\n`);
  });
  dlog(`emit session event sid=${sid} type=${type}`);
}

function setChallengeState(challengeId, patch) {
  const current = challengeStates.get(challengeId) || { challenge_id: challengeId };
  const next = { ...current, ...patch, updated_at: nowIso() };
  challengeStates.set(challengeId, next);
  return next;
}

async function postJson(url, body, serviceConfig, extraHeaders = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client-Id": serviceConfig.client_id,
      "X-Client-Secret": serviceConfig.client_secret,
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({ error: "invalid_json_response" }));
  if (!response.ok) {
    throw new Error(`${url} ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  const data = await response.json().catch(() => ({ error: "invalid_json_response" }));
  if (!response.ok) {
    throw new Error(`${url} ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function checkLocalWalletHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_WALLET_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${LOCAL_WALLET_URL}/health`, {
      method: "GET",
      signal: controller.signal
    });
    if (!response.ok) {
      return false;
    }
    const data = await response.json().catch(() => ({}));
    return data && data.ok === true;
  } catch (_err) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function finalizeChallenge(challengeId, authorizationCode) {
  try {
    console.log(`[service-backend] finalize start challenge=${challengeId}`);
    const challengeStatus = await getJson(
      `${GATEWAY_URL}/v1/auth/challenges/${encodeURIComponent(challengeId)}/status`
    );
    if (challengeStatus.status !== "verified") {
      throw new Error(`challenge_not_verified:${challengeStatus.status}`);
    }
    if (challengeStatus.authorization_code !== authorizationCode) {
      throw new Error("authorization_code_mismatch");
    }

    const challengeState = challengeStates.get(challengeId);
    const serviceId = challengeState?.service_id || defaultServiceId;
    const config = serviceConfigs.get(serviceId) || Array.from(serviceConfigs.values())[0];

    console.log(`[service-backend] token exchange info: service=${serviceId} client=${config.client_id} redirect=${config.redirect_uri}`);

    const tokenData = await postJson(`${GATEWAY_URL}/v1/token/exchange`, {
      grant_type: "authorization_code",
      code: authorizationCode,
      client_id: config.client_id,
      redirect_uri: config.redirect_uri
    }, config);

    const profile = await getJson(
      `${GATEWAY_URL}/v1/services/${encodeURIComponent(serviceId)}/profile`,
      { Authorization: `Bearer ${tokenData.access_token}` }
    );

    const session = createSession(serviceId, {
      gatewaySessionId: tokenData.session_id || null,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      scope: tokenData.scope,
      profile
    });

    // Ensure session event stream is open for this client
    if (config.client_id) {
      startGatewaySessionEventStream(config.client_id);
    }

    const state = setChallengeState(challengeId, {
      status: "active",
      session_id: session.sid,
      profile
    });
    console.log(`[service-backend] finalize success challenge=${challengeId} session=${session.sid}`);
    emitChallengeEvent(challengeId, "active", state);

    const stream = gatewayStreams.get(challengeId);
    if (stream) {
      stream.close();
      gatewayStreams.delete(challengeId);
    }
  } catch (err) {
    console.error(`[service-backend] finalize failed challenge=${challengeId}: ${err.message}`);
    const state = setChallengeState(challengeId, {
      status: "error",
      error: err.message
    });
    emitChallengeEvent(challengeId, "error", state);
  }
}

// Obsolete startGatewaySessionEventStream removed from end, now called per client

function startGatewayChallengeStream(challengeId) {
  if (gatewayStreams.has(challengeId)) {
    return;
  }
  const serviceConfig = serviceConfigs.get(challengeStates.get(challengeId)?.service_id) || Array.from(serviceConfigs.values())[0];

  const es = new EventSource(`${GATEWAY_URL}/v1/service/events?challenge_id=${encodeURIComponent(challengeId)}`, {
    fetch: (input, init) => {
      const headers = {
        ...(init?.headers || {}),
        "X-Client-Id": serviceConfig.client_id,
        "X-Client-Secret": serviceConfig.client_secret
      };
      return fetch(input, {
        ...init,
        headers
      });
    }
  });
  gatewayStreams.set(challengeId, es);
  dlog(`gateway stream opening challenge=${challengeId}`);

  es.onopen = () => {
    dlog(`gateway stream connected challenge=${challengeId}`);
  };

  es.addEventListener("challenge_verified", async (event) => {
    const data = JSON.parse(event.data);
    const code = data.payload.authorization_code;
    console.log(`[service-backend] challenge verified event challenge=${challengeId}`);
    const state = setChallengeState(challengeId, {
      status: "approved",
      authorization_code: code,
      verified_at: data.at
    });
    emitChallengeEvent(challengeId, "approved", state);
    if (AUTO_FINALIZE) {
      await finalizeChallenge(challengeId, code);
    }
  });

  es.addEventListener("challenge_denied", () => {
    const state = setChallengeState(challengeId, { status: "denied" });
    emitChallengeEvent(challengeId, "denied", state);
    es.close();
    gatewayStreams.delete(challengeId);
    dlog(`gateway stream close denied challenge=${challengeId}`);
  });

  es.addEventListener("challenge_expired", () => {
    const state = setChallengeState(challengeId, { status: "expired" });
    emitChallengeEvent(challengeId, "expired", state);
    es.close();
    gatewayStreams.delete(challengeId);
    dlog(`gateway stream close expired challenge=${challengeId}`);
  });

  es.onerror = (err) => {
    dlog(`gateway stream error challenge=${challengeId}: ${err.message || "connection failed"}`);
    // Auto-reconnect handled by EventSource. Keep stream unless state is terminal.
    const state = challengeStates.get(challengeId);
    if (state && ["active", "denied", "expired", "error"].includes(state.status)) {
      es.close();
      gatewayStreams.delete(challengeId);
      dlog(`gateway stream close terminal challenge=${challengeId}`);
    }
  };
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (origin.includes("localhost:3000") || origin.includes("127.0.0.1:3000"))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "service-backend", now: nowIso() });
});

app.get("/services", (req, res) => {
  res.json(Array.from(serviceConfigs.values()));
});

app.post("/service/save", (req, res) => {
  const { service_id, service_name, requested_fields } = req.body || {};
  if (!service_id || !requested_fields) {
    return res.status(400).json({ error: "invalid_request", message: "service_id and requested_fields are required" });
  }

  const claims = requested_fields.split(",").map(s => s.trim()).filter(Boolean);
  const redirectHost = process.env.REDIRECT_HOST || "service-test.local";
  const config = {
    service_id,
    client_id: service_id, // simple 1:1 for now
    client_secret: process.env.CLIENT_SECRET || "dev-service-secret",
    redirect_uri: `https://${service_id}.${redirectHost.split('.').slice(1).join('.')}/callback`,
    requested_claims: claims,
    service_name: service_name || service_id,
    registered: false
  };

  // Special case for default-like behavior
  if (service_id === "service-test") {
    config.redirect_uri = REDIRECT_URI;
  }

  serviceConfigs.set(service_id, config);
  saveConfigs();
  res.json({ success: true, service: config });
});

app.post("/service/:id/register", async (req, res) => {
  const serviceId = req.params.id;
  const config = serviceConfigs.get(serviceId);
  if (!config) {
    return res.status(404).json({ error: "service_not_found" });
  }

  try {
    // Register to gateway
    // We use any already registered service to authorize this registration call, 
    // or use the config itself if it's the first one.
    const authConfig = Array.from(serviceConfigs.values()).find(s => s.registered) || config;

    await postJson(`${GATEWAY_URL}/v1/services`, {
      client_id: config.client_id,
      service_id: config.service_id,
      client_secret: config.client_secret,
      redirect_uris: [config.redirect_uri]
    }, authConfig);

    config.registered = true;
    serviceConfigs.set(serviceId, config);
    saveConfigs();

    // Start session stream immediately for this new client
    startGatewaySessionEventStream(config.client_id);

    res.json({ success: true, service: config });
  } catch (err) {
    res.status(500).json({ error: "registration_failed", message: err.message });
  }
});

app.post("/auth/start", async (req, res) => {
  try {
    const { did, service_id } = req.body || {};
    const targetServiceId = service_id || defaultServiceId;
    const config = serviceConfigs.get(targetServiceId);

    if (!config) {
      return res.status(404).json({ error: "service_not_found" });
    }
    if (!config.registered) {
      return res.status(403).json({ error: "service_not_registered", message: "Register service with gateway first" });
    }

    const didHint = did || null;
    const requestedScopes = ["profile", "email"];
    if (LOCAL_WALLET_REQUIRED) {
      const localWalletOk = await checkLocalWalletHealth();
      if (!localWalletOk) {
        return res.status(409).json({
          error: "wallet_local_unreachable",
          message: "Local MiID Wallet is required on this device.",
          action_hint: "open_wallet_on_this_device",
          wallet_url: LOCAL_WALLET_URL
        });
      }
    }

    const challenge = await postJson(`${GATEWAY_URL}/v1/auth/challenge`, {
      service_id: config.service_id,
      client_id: config.client_id,
      redirect_uri: config.redirect_uri,
      scopes: requestedScopes,
      requested_claims: config.requested_claims,
      did_hint: didHint,
      require_user_approval: true
    }, config, {
      "X-Local-Wallet-Ready": LOCAL_WALLET_REQUIRED ? "1" : "0"
    });

    const normalizedStatus = challenge.status === "verified" ? "approved" : (challenge.status || "pending");
    const state = setChallengeState(challenge.challenge_id, {
      status: normalizedStatus,
      challenge_id: challenge.challenge_id,
      nonce: challenge.nonce,
      expires_at: challenge.expires_at,
      service_id: config.service_id,
      authorization_code: challenge.authorization_code || null
    });

    if (state.status === "pending") {
      startGatewayChallengeStream(challenge.challenge_id);
    } else if (state.status === "approved" && state.authorization_code && AUTO_FINALIZE) {
      await finalizeChallenge(challenge.challenge_id, state.authorization_code);
    }
    console.log(`[service-backend] auth start challenge=${challenge.challenge_id} service=${config.service_id}`);

    return res.status(201).json({
      challenge_id: challenge.challenge_id,
      nonce: challenge.nonce,
      expires_at: challenge.expires_at,
      stream_url: `/auth/stream/${encodeURIComponent(challenge.challenge_id)}`,
      status: state.status
    });
  } catch (err) {
    return res.status(500).json({ error: "auth_start_failed", message: err.message });
  }
});

app.get("/auth/stream/:challengeId", (req, res) => {
  const challengeId = req.params.challengeId;
  const state = challengeStates.get(challengeId);
  if (!state) {
    return res.status(404).json({ error: "challenge_not_found" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  dlog(`frontend stream connected challenge=${challengeId}`);

  const snapshot = JSON.stringify({ type: "snapshot", payload: state, at: nowIso() });
  res.write(`event: snapshot\n`);
  res.write(`data: ${snapshot}\n\n`);

  const subs = challengeClients.get(challengeId) || new Set();
  subs.add(res);
  challengeClients.set(challengeId, subs);

  const keepAlive = setInterval(() => {
    res.write(`event: ping\ndata: {}\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    const current = challengeClients.get(challengeId);
    if (!current) {
      return;
    }
    current.delete(res);
    if (current.size === 0) {
      challengeClients.delete(challengeId);
    }
    dlog(`frontend stream disconnected challenge=${challengeId}`);
  });
});

app.get("/session/stream", (req, res) => {
  const serviceId = req.query.service_id;
  const session = getSession(req, serviceId);
  if (!session) {
    return res.status(401).json({ error: "not_authenticated" });
  }

  const sid = session.sid;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  dlog(`frontend session stream connected sid=${sid} service=${serviceId}`);
  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({ sid, service_id: serviceId, at: nowIso() })}\n\n`);

  const subs = sessionClients.get(sid) || new Set();
  subs.add(res);
  sessionClients.set(sid, subs);
  const keepAlive = setInterval(() => {
    res.write(`event: ping\ndata: {}\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    const current = sessionClients.get(sid);
    if (!current) {
      return;
    }
    current.delete(res);
    if (current.size === 0) {
      sessionClients.delete(sid);
    }
    dlog(`frontend session stream disconnected sid=${sid}`);
  });
});

app.get("/auth/status/:challengeId", (req, res) => {
  const state = challengeStates.get(req.params.challengeId);
  if (!state) {
    return res.status(404).json({ error: "challenge_not_found" });
  }
  return res.json(state);
});

app.post("/auth/complete/:challengeId", (req, res) => {
  const state = challengeStates.get(req.params.challengeId);
  if (!state) {
    return res.status(404).json({ error: "challenge_not_found" });
  }
  if (state.status !== "active" || !state.session_id) {
    return res.status(409).json({ error: "not_active_yet", status: state.status });
  }

  const session = sessions.get(state.session_id);
  if (!session) {
    return res.status(404).json({ error: "session_not_found" });
  }

  res.setHeader(
    "Set-Cookie",
    `sid_${session.service_id}=${session.sid}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_MS / 1000}; Path=/`
  );

  return res.json({
    status: "active",
    session_id: session.sid,
    profile: session.profile
  });
});

app.post("/auth/finalize/:challengeId", async (req, res) => {
  const challengeId = req.params.challengeId;
  const state = challengeStates.get(challengeId);
  if (!state) {
    return res.status(404).json({ error: "challenge_not_found" });
  }
  if (state.status !== "approved" || !state.authorization_code) {
    return res.status(409).json({ error: "not_approved", status: state.status });
  }
  await finalizeChallenge(challengeId, state.authorization_code);
  const next = challengeStates.get(challengeId);
  return res.json(next);
});

app.get("/profile", (req, res) => {
  const serviceId = req.query.service_id || defaultServiceId;
  const session = getSession(req, serviceId);
  if (!session) {
    return res.status(401).json({ error: "not_authenticated", message: "No valid session", service_id: serviceId });
  }

  const { profile, scope, expiresAt } = session;
  const config = serviceConfigs.get(serviceId) || {};

  const scopeText = scope || profile?.scope || "";
  const approvedClaims = Array.isArray(profile?.approved_claims) ? profile.approved_claims : [];
  const approvedSet = new Set(approvedClaims);
  const profileResponse = {
    subject_id: profile?.subject_id || null,
    did: profile?.did || null,
    service_id: serviceId,
    scope: scopeText || null,
    requested_claims: Array.isArray(profile?.requested_claims) ? profile.requested_claims : (config.requested_claims || []),
    approved_claims: approvedClaims,
    risk_level: profile?.risk_level || "normal",
    session_expires_at: expiresAt
  };

  // Dynamically add all approved claims from the profile data
  // The profile object from Gateway now contains actual values for approved keys
  if (profile) {
    Object.keys(profile).forEach(key => {
      if (approvedSet.has(key)) {
        profileResponse[key] = profile[key];
      }
    });
  }

  return res.json(profileResponse);
});

// Obsolete service manage endpoint removed in favor of /service/save and /service/register

app.post("/logout", (req, res) => {
  const { service_id } = req.body || {};
  if (service_id) {
    const session = getSession(req, service_id);
    if (session) {
      deleteSession(session.sid);
    }
    res.setHeader("Set-Cookie", `sid_${service_id}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`);
    return res.json({ success: true, message: `Logged out from ${service_id}` });
  }

  // Fallback: logout all MiID sessions
  const cookies = parseCookies(req.headers.cookie);
  const clearedPaths = [];
  Object.keys(cookies).forEach(name => {
    if (name.startsWith("sid")) {
      deleteSession(cookies[name]);
      clearedPaths.push(`${name}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`);
    }
  });

  if (clearedPaths.length > 0) {
    res.setHeader("Set-Cookie", clearedPaths);
  } else {
    res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/");
  }
  return res.json({ success: true, message: "Logged out all sessions" });
});

app.listen(PORT, () => {
  console.log(`service-backend listening on http://localhost:${PORT}`);
  console.log(`Gateway URL: ${GATEWAY_URL}`);
  console.log(`Local wallet required: ${LOCAL_WALLET_REQUIRED ? "on" : "off"} (${LOCAL_WALLET_URL})`);
  console.log(`Auto finalize: ${AUTO_FINALIZE ? "on" : "off"}`);
  console.log(`Debug auth: ${DEBUG_AUTH ? "on" : "off"}`);
});

// Initialize
loadConfigs();
startGatewaySessionEventStream(CLIENT_ID);

// Start background connection for any other pre-registered clients
for (const config of serviceConfigs.values()) {
  if (config.registered && config.service_id !== defaultServiceId) {
    startGatewaySessionEventStream(config.client_id);
  }
}

module.exports = { app };
