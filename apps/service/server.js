const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventSource } = require("eventsource");

const PORT = Number(process.env.SERVICE_PORT || 15000);
const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:14000";
const SERVICE_ID = process.env.SERVICE_ID || "service-test";
const CLIENT_ID = process.env.SERVICE_CLIENT_ID || "web-client";
const REDIRECT_URI = process.env.SERVICE_REDIRECT_URI || "https://service-test.local/callback";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const requests = new Map();
const clients = new Map();
const gatewayEventSources = new Map();

function nowIso() {
  return new Date().toISOString();
}

function getDidFromWalletData() {
  const walletPath = path.join(__dirname, "..", "..", "data", "wallet.json");
  if (!fs.existsSync(walletPath)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  if (!parsed.wallets || !parsed.wallets[0]) {
    return null;
  }
  return parsed.wallets[0].did;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${url} ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

function emit(requestId, type, payload) {
  const set = clients.get(requestId);
  if (!set) {
    return;
  }
  const body = JSON.stringify({ type, payload, at: nowIso() });
  set.forEach((res) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${body}\n\n`);
  });
}

function saveRequest(requestId, patch) {
  const current = requests.get(requestId) || {};
  const next = { ...current, ...patch, updated_at: nowIso() };
  requests.set(requestId, next);
  return next;
}

async function finalizeLogin(requestId, authorizationCode) {
  const reqState = requests.get(requestId);
  if (!reqState) {
    return;
  }
  try {
    const token = await postJson(`${GATEWAY_URL}/v1/token/exchange`, {
      grant_type: "authorization_code",
      code: authorizationCode,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI
    });
    const profileRes = await fetch(`${GATEWAY_URL}/v1/services/${SERVICE_ID}/profile`, {
      headers: { authorization: `Bearer ${token.access_token}` }
    });
    const profile = await profileRes.json();
    const next = saveRequest(requestId, {
      status: "active",
      access_token: token.access_token,
      profile
    });
    emit(requestId, "active", next);
    const es = gatewayEventSources.get(requestId);
    if (es) {
      es.close();
      gatewayEventSources.delete(requestId);
    }
  } catch (err) {
    const next = saveRequest(requestId, { status: "error", error: err.message });
    emit(requestId, "error", next);
    const es = gatewayEventSources.get(requestId);
    if (es) {
      es.close();
      gatewayEventSources.delete(requestId);
    }
  }
}

function watchChallenge(requestId, challengeId) {
  const es = new EventSource(`${GATEWAY_URL}/v1/service/events?challenge_id=${encodeURIComponent(challengeId)}`);
  gatewayEventSources.set(requestId, es);
  saveRequest(requestId, { challenge_id: challengeId });

  es.addEventListener("challenge_verified", async (event) => {
    const data = JSON.parse(event.data);
    const authorizationCode = data.payload.authorization_code;
    const next = saveRequest(requestId, {
      status: "approved",
      authorization_code: authorizationCode
    });
    emit(requestId, "approved", next);
    await finalizeLogin(requestId, authorizationCode);
  });

  es.addEventListener("challenge_denied", () => {
    const next = saveRequest(requestId, { status: "denied" });
    emit(requestId, "denied", next);
    es.close();
    gatewayEventSources.delete(requestId);
  });

  es.addEventListener("challenge_expired", () => {
    const next = saveRequest(requestId, { status: "expired" });
    emit(requestId, "expired", next);
    es.close();
    gatewayEventSources.delete(requestId);
  });

  es.onerror = () => {
    const state = requests.get(requestId);
    if (!state) {
      es.close();
    }
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "service-backend", now: nowIso() });
});

app.post("/demo/request", async (_req, res) => {
  try {
    const did = getDidFromWalletData();
    if (!did) {
      return res.status(400).json({ error: "wallet_did_not_found" });
    }

    const challenge = await postJson(`${GATEWAY_URL}/v1/auth/challenge`, {
      service_id: SERVICE_ID,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scopes: ["profile", "email"],
      did_hint: did
    });

    const requestId = crypto.randomUUID();
    const initial = saveRequest(requestId, {
      id: requestId,
      did,
      status: "pending",
      challenge_id: challenge.challenge_id,
      created_at: nowIso()
    });
    watchChallenge(requestId, challenge.challenge_id);
    return res.status(201).json(initial);
  } catch (err) {
    return res.status(500).json({ error: "request_failed", message: err.message });
  }
});

app.get("/demo/events/:requestId", (req, res) => {
  const requestId = req.params.requestId;
  const state = requests.get(requestId);
  if (!state) {
    return res.status(404).json({ error: "request_not_found" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(`event: snapshot\n`);
  res.write(`data: ${JSON.stringify({ type: "snapshot", payload: state, at: nowIso() })}\n\n`);

  const current = clients.get(requestId) || new Set();
  current.add(res);
  clients.set(requestId, current);
  const keepAlive = setInterval(() => {
    res.write(`event: ping\ndata: {}\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    const set = clients.get(requestId);
    if (!set) {
      return;
    }
    set.delete(res);
    if (set.size === 0) {
      clients.delete(requestId);
    }
  });
});

app.get("/demo/state/:requestId", (req, res) => {
  const state = requests.get(req.params.requestId);
  if (!state) {
    return res.status(404).json({ error: "request_not_found" });
  }
  return res.json(state);
});

app.listen(PORT, () => {
  console.log(`service demo listening on http://localhost:${PORT}`);
});
