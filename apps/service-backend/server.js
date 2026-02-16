const express = require("express");
const crypto = require("crypto");
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

const sessions = new Map();
const gatewaySessionToLocalSid = new Map();
const challengeStates = new Map();
const challengeClients = new Map();
const gatewayStreams = new Map();
const sessionClients = new Map();
let gatewaySessionEventSource = null;

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

function createSession(userData) {
  const sid = generateSessionId();
  const session = {
    sid,
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

function getSession(sid) {
  const session = sessions.get(sid);
  if (!session) return null;
  if (new Date(session.expiresAt) < new Date()) {
    sessions.delete(sid);
    return null;
  }
  return session;
}

function deleteSession(sid) {
  const current = sessions.get(sid);
  if (current && current.gatewaySessionId) {
    gatewaySessionToLocalSid.delete(current.gatewaySessionId);
  }
  sessions.delete(sid);
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

async function postJson(url, body, extraHeaders = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client-Id": CLIENT_ID,
      "X-Client-Secret": CLIENT_SECRET,
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

    const tokenData = await postJson(`${GATEWAY_URL}/v1/token/exchange`, {
      grant_type: "authorization_code",
      code: authorizationCode,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI
    });

    const profile = await getJson(
      `${GATEWAY_URL}/v1/services/${encodeURIComponent(SERVICE_ID)}/profile`,
      { Authorization: `Bearer ${tokenData.access_token}` }
    );

    const session = createSession({
      gatewaySessionId: tokenData.session_id || null,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      scope: tokenData.scope,
      profile
    });

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

function startGatewaySessionEventStream() {
  if (gatewaySessionEventSource) {
    return;
  }
  const es = new EventSource(`${GATEWAY_URL}/v1/service/session-events`, {
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        headers: {
          ...(init?.headers || {}),
          "X-Client-Id": CLIENT_ID,
          "X-Client-Secret": CLIENT_SECRET
        }
      })
  });
  gatewaySessionEventSource = es;
  dlog("gateway session stream open");

  es.addEventListener("session_revoked", (event) => {
    try {
      const data = JSON.parse(event.data);
      const gatewaySessionId = data.payload?.session_id;
      if (!gatewaySessionId) {
        return;
      }
      const sid = gatewaySessionToLocalSid.get(gatewaySessionId);
      if (!sid) {
        return;
      }
      deleteSession(sid);
      emitSessionEvent(sid, "force_logout", {
        reason: "revoked",
        session_id: gatewaySessionId
      });
      dlog(`force logout sid=${sid} gateway_session=${gatewaySessionId}`);
    } catch (err) {
      dlog(`session stream parse error: ${err.message}`);
    }
  });

  es.onerror = () => {
    dlog("gateway session stream error");
  };
}

function startGatewayChallengeStream(challengeId) {
  if (gatewayStreams.has(challengeId)) {
    return;
  }
  const es = new EventSource(`${GATEWAY_URL}/v1/service/events?challenge_id=${encodeURIComponent(challengeId)}`, {
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        headers: {
          ...(init?.headers || {}),
          "X-Client-Id": CLIENT_ID,
          "X-Client-Secret": CLIENT_SECRET
        }
      })
  });
  gatewayStreams.set(challengeId, es);
  dlog(`gateway stream open challenge=${challengeId}`);

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

  es.onerror = () => {
    dlog(`gateway stream error challenge=${challengeId}`);
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

app.use((req, _res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.sid) {
    req.session = getSession(cookies.sid);
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "service-backend", now: nowIso() });
});

app.post("/auth/start", async (req, res) => {
  try {
    const { did } = req.body || {};
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
      service_id: SERVICE_ID,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scopes: requestedScopes,
      did_hint: didHint,
      require_user_approval: true
    }, {
      "X-Local-Wallet-Ready": LOCAL_WALLET_REQUIRED ? "1" : "0"
    });

    const normalizedStatus = challenge.status === "verified" ? "approved" : (challenge.status || "pending");
    const state = setChallengeState(challenge.challenge_id, {
      status: normalizedStatus,
      challenge_id: challenge.challenge_id,
      nonce: challenge.nonce,
      expires_at: challenge.expires_at,
      authorization_code: challenge.authorization_code || null
    });

    if (state.status === "pending") {
      startGatewayChallengeStream(challenge.challenge_id);
    } else if (state.status === "approved" && state.authorization_code && AUTO_FINALIZE) {
      await finalizeChallenge(challenge.challenge_id, state.authorization_code);
    }
    console.log(`[service-backend] auth start challenge=${challenge.challenge_id}`);

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
  if (!req.session) {
    return res.status(401).json({ error: "not_authenticated" });
  }
  const sid = req.session.sid;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  dlog(`frontend session stream connected sid=${sid}`);
  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({ sid, at: nowIso() })}\n\n`);

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
    `sid=${session.sid}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_MS / 1000}; Path=/`
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
  if (!req.session) {
    return res.status(401).json({ error: "not_authenticated", message: "No valid session" });
  }

  const { profile, scope, expiresAt } = req.session;
  return res.json({
    subject_id: profile?.subject_id || null,
    did: profile?.did || null,
    service_id: profile?.service_id || SERVICE_ID,
    scope: scope || profile?.scope || null,
    risk_level: profile?.risk_level || "normal",
    session_expires_at: expiresAt
  });
});

app.post("/logout", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.sid) {
    deleteSession(cookies.sid);
  }
  res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/");
  return res.json({ success: true, message: "Logged out successfully" });
});

app.listen(PORT, () => {
  console.log(`service-backend listening on http://localhost:${PORT}`);
  console.log(`Gateway URL: ${GATEWAY_URL}`);
  console.log(`Local wallet required: ${LOCAL_WALLET_REQUIRED ? "on" : "off"} (${LOCAL_WALLET_URL})`);
  console.log(`Auto finalize: ${AUTO_FINALIZE ? "on" : "off"}`);
  console.log(`Debug auth: ${DEBUG_AUTH ? "on" : "off"}`);
});

startGatewaySessionEventStream();

module.exports = { app };
