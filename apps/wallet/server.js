const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.WALLET_PORT || 17000);
function getSignSecret() {
  return process.env.WALLET_SIGN_SECRET || null;
}
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DATA_FILE = path.join(DATA_DIR, "wallet.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ wallets: [], consents: [] }, null, 2));
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

function buildDid(walletId) {
  return `did:miid:${walletId}`;
}

function signPayload(privateKeyPem, payload) {
  return crypto.sign(null, Buffer.from(payload), privateKeyPem).toString("base64url");
}

function createWalletApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "wallet", now: nowIso() });
  });

  app.post("/v1/wallets", (req, res) => {
  const { name } = req.body || {};
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" });

  const store = readStore();
  const wallet = {
    id: crypto.randomUUID(),
    name: name || "user",
    did: null,
    public_key_pem: publicKeyPem,
    private_key_pem: privateKeyPem,
    created_at: nowIso()
  };
  wallet.did = buildDid(wallet.id);
  store.wallets.push(wallet);
  writeStore(store);

  return res.status(201).json({
    wallet_id: wallet.id,
    did: wallet.did,
    public_key_pem: wallet.public_key_pem
  });
  });

  app.get("/v1/wallets/:walletId", (req, res) => {
  const store = readStore();
  const wallet = store.wallets.find((w) => w.id === req.params.walletId);
  if (!wallet) {
    return res.status(404).json({ error: "wallet_not_found" });
  }
  return res.json({
    wallet_id: wallet.id,
    did: wallet.did,
    name: wallet.name,
    public_key_pem: wallet.public_key_pem
  });
  });

  app.get("/v1/wallets/by-did/:did", (req, res) => {
  const did = decodeURIComponent(req.params.did);
  const store = readStore();
  const wallet = store.wallets.find((w) => w.did === did);
  if (!wallet) {
    return res.status(404).json({ error: "did_not_found" });
  }
  return res.json({
    wallet_id: wallet.id,
    did: wallet.did,
    kid: `${wallet.did}#key-1`,
    public_key_pem: wallet.public_key_pem
  });
  });

  app.post("/v1/wallets/sign", (req, res) => {
  const signSecret = getSignSecret();
  if (signSecret) {
    const sent = req.headers["x-wallet-sign-secret"];
    if (sent !== signSecret) {
      return res.status(401).json({ error: "unauthorized_sign_request" });
    }
  }
  const { did, challenge_id, nonce, audience, expires_at } = req.body || {};
  if (!did || !challenge_id || !nonce || !audience || !expires_at) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const store = readStore();
  const wallet = store.wallets.find((w) => w.did === did);
  if (!wallet) {
    return res.status(404).json({ error: "wallet_not_found" });
  }

  const payload = JSON.stringify({ challenge_id, nonce, audience, expires_at });
  const signature = signPayload(wallet.private_key_pem, payload);
  return res.json({
    did,
    kid: `${wallet.did}#key-1`,
    signature,
    signed_payload: JSON.parse(payload)
  });
  });

  app.post("/v1/wallets/consents", (req, res) => {
  const { did, service_id, scopes } = req.body || {};
  if (!did || !service_id || !Array.isArray(scopes) || scopes.length === 0) {
    return res.status(400).json({ error: "invalid_request" });
  }
  const store = readStore();
  const wallet = store.wallets.find((w) => w.did === did);
  if (!wallet) {
    return res.status(404).json({ error: "wallet_not_found" });
  }
  const consent = {
    id: crypto.randomUUID(),
    did,
    service_id,
    scopes: [...new Set(scopes)],
    created_at: nowIso()
  };
  store.consents.push(consent);
  writeStore(store);
  return res.status(201).json(consent);
  });

  return app;
}

function startWalletServer(options = {}) {
  const port = Number(options.port || PORT);
  const app = createWalletApp();
  const server = app.listen(port, () => {
    console.log(`wallet listening on http://localhost:${port}`);
  });
  return server;
}

if (require.main === module) {
  startWalletServer();
}

module.exports = {
  createWalletApp,
  startWalletServer
};
