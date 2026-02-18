const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.WALLET_PORT || 17000);
function getSignSecret() {
  return process.env.WALLET_SIGN_SECRET || null;
}
const DEBUG_AUTH = process.env.DEBUG_AUTH === "1";

function getDataDir() {
  if (process.env.MIID_DATA_DIR) {
    return process.env.MIID_DATA_DIR;
  }
  return path.join(__dirname, "..", "..", "data");
}

function getDataFile() {
  return path.join(getDataDir(), "wallet.json");
}

function dlog(message) {
  if (DEBUG_AUTH) {
    console.log(`[wallet] ${message}`);
  }
}

function ensureStore() {
  const dataDir = getDataDir();
  const dataFile = getDataFile();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify({ wallets: [], consents: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(getDataFile(), "utf8"));
}

function writeStore(data) {
  fs.writeFileSync(getDataFile(), JSON.stringify(data, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function buildDid(walletId) {
  return `did:miid:${walletId}`;
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function migrateWallet(wallet) {
  let changed = false;
  let profile = wallet.profile || {};

  // 1. Initial Migration (if no profile object exists)
  if (!wallet.profile) {
    if (wallet.name) profile.name = { label: "이름", value: wallet.name || "user" };
    if (wallet.email) profile.email = { label: "이메일", value: wallet.email };
    if (wallet.nickname) profile.nickname = { label: "닉네임", value: wallet.nickname };

    if (!profile.name) profile.name = { label: "이름", value: "user" };

    if (wallet.custom_fields) {
      Object.entries(wallet.custom_fields).forEach(([key, data]) => {
        if (typeof data === "object" && data.label) {
          profile[key] = { label: data.label, value: data.value || "" };
        } else {
          profile[key] = { label: key, value: String(data) };
        }
      });
    }

    const knownKeys = ["id", "did", "name", "email", "nickname", "public_key_pem", "private_key_pem", "created_at", "custom_fields", "profile"];
    Object.keys(wallet).forEach(key => {
      if (!knownKeys.includes(key)) {
        profile[key] = { label: key, value: String(wallet[key]) };
        delete wallet[key];
        changed = true;
      }
    });

    wallet.profile = profile;
    delete wallet.name;
    delete wallet.email;
    delete wallet.nickname;
    delete wallet.custom_fields;
    changed = true;
  }

  // 2. Self-Healing: Flatten nested value objects (Pollution Recovery)
  Object.keys(profile).forEach(key => {
    let item = profile[key];
    while (item && item.value && typeof item.value === "object" && item.value.value !== undefined) {
      item.value = item.value.value;
      changed = true;
    }
    if (item && typeof item.value === "string" && item.value === "[object Object]") {
      item.value = "";
      changed = true;
    }
  });

  return { wallet, changed };
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
    const { profile: reqProfile } = req.body || {};
    const keyPair = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" });
    const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" });

    const store = readStore();

    // Initialize with provided profile or default samples
    let profile = {};
    if (reqProfile && typeof reqProfile === "object") {
      profile = reqProfile;
    } else {
      profile = {
        name: { label: "이름", value: normalizeText(req.body?.name) || "user" },
        email: { label: "이메일", value: normalizeText(req.body?.email) || "" },
        nickname: { label: "닉네임", value: normalizeText(req.body?.nickname) || "" }
      };
    }

    const wallet = {
      id: crypto.randomUUID(),
      profile,
      did: null,
      public_key_pem: publicKeyPem,
      private_key_pem: privateKeyPem,
      created_at: nowIso()
    };
    wallet.did = buildDid(wallet.id);
    store.wallets.push(wallet);
    writeStore(store);
    dlog(`wallet created did=${wallet.did}`);

    return res.status(201).json({
      wallet_id: wallet.id,
      did: wallet.did,
      public_key_pem: wallet.public_key_pem,
      profile: wallet.profile
    });
  });

  app.get("/v1/wallets", (_req, res) => {
    const store = readStore();
    let anyChanged = false;
    const wallets = store.wallets.map((w) => {
      const { wallet, changed } = migrateWallet(w);
      if (changed) anyChanged = true;
      const { private_key_pem, ...rest } = wallet;
      return {
        wallet_id: wallet.id,
        ...rest
      };
    });
    if (anyChanged) writeStore(store);
    return res.json({ wallets });
  });

  app.get("/v1/wallets/:walletId", (req, res) => {
    const store = readStore();
    let w = store.wallets.find((w) => w.id === req.params.walletId);
    if (!w) {
      return res.status(404).json({ error: "wallet_not_found" });
    }
    const { wallet, changed } = migrateWallet(w);
    if (changed) writeStore(store);
    return res.json({
      wallet_id: wallet.id,
      did: wallet.did,
      profile: wallet.profile,
      public_key_pem: wallet.public_key_pem
    });
  });

  app.get("/v1/wallets/by-did/:did", (req, res) => {
    const did = decodeURIComponent(req.params.did);
    const store = readStore();
    let w = store.wallets.find((w) => w.did === did);
    if (!w) {
      dlog(`did lookup miss did=${did}`);
      return res.status(404).json({ error: "did_not_found" });
    }
    const { wallet, changed } = migrateWallet(w);
    if (changed) writeStore(store);
    dlog(`did lookup hit did=${did}`);
    return res.json({
      wallet_id: wallet.id,
      did: wallet.did,
      kid: `${wallet.did}#key-1`,
      public_key_pem: wallet.public_key_pem,
      profile: wallet.profile
    });
  });

  app.put("/v1/wallets/by-did/:did/profile", (req, res) => {
    const did = decodeURIComponent(req.params.did);
    const store = readStore();
    let w = store.wallets.find((w) => w.did === did);
    if (!w) {
      return res.status(404).json({ error: "wallet_not_found" });
    }
    const { wallet } = migrateWallet(w);

    const body = req.body || {};
    // Robustly handle both wrapped: { profile: { ... } } and unwrapped: { key: { label, value } }
    let newProfile = {};
    if (body.profile && typeof body.profile === "object") {
      newProfile = body.profile;
    } else if (Object.keys(body).length > 0 && !body.did) {
      // If it looks like a profile object directly
      newProfile = body;
    }

    if (Object.keys(newProfile).length > 0) {
      const cleanedProfile = {};
      // Standardize and clean nested values before saving
      Object.entries(newProfile).forEach(([key, data]) => {
        if (data && typeof data === "object") {
          let val = data.value;
          // Flatten nested values: { label, value: { value } } -> { label, value }
          while (val && typeof val === "object" && val.value !== undefined) {
            val = val.value;
          }
          cleanedProfile[key] = {
            label: data.label || key,
            value: (val === undefined || val === null) ? "" : String(val)
          };
        } else {
          // If scalar, wrap it
          cleanedProfile[key] = { label: key, value: String(data || "") };
        }
      });
      wallet.profile = cleanedProfile; // Entirely replace to support deletion
    } else if (body.profile && typeof body.profile === "object") {
      // Handle explicit empty profile update
      wallet.profile = {};
    } else {
      // Legacy fallback for partial fields - keeping merge behavior for legacy partial updates
      if (body.name !== undefined) wallet.profile.name = { label: "이름", value: String(body.name || "user") };
      if (body.email !== undefined) wallet.profile.email = { label: "이메일", value: String(body.email || "") };
      if (body.nickname !== undefined) wallet.profile.nickname = { label: "닉네임", value: String(body.nickname || "") };
    }

    writeStore(store);
    dlog(`profile updated did=${did}`);

    return res.json({
      wallet_id: wallet.id,
      did: wallet.did,
      profile: wallet.profile,
      updated_at: nowIso()
    });
  });

  app.post("/v1/wallets/sign", (req, res) => {
    const reqDid = req.body?.did || "unknown";
    const reqChallenge = req.body?.challenge_id || "unknown";
    dlog(`sign request did=${reqDid} challenge_id=${reqChallenge}`);
    const signSecret = getSignSecret();
    if (signSecret) {
      const sent = req.headers["x-wallet-sign-secret"];
      if (sent !== signSecret) {
        dlog(`sign rejected unauthorized did=${reqDid}`);
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
    dlog(`sign ok did=${did} challenge_id=${challenge_id}`);
    return res.json({
      did,
      kid: `${wallet.did}#key-1`,
      signature,
      signed_payload: JSON.parse(payload)
    });
  });

  app.post("/v1/wallets/consents", (req, res) => {
    const { did, service_id, scopes } = req.body || {};
    if (!did || !service_id || !Array.isArray(scopes)) {
      return res.status(400).json({ error: "invalid_request" });
    }

    const store = readStore();
    let consent = store.consents.find((c) => c.did === did && c.service_id === service_id);

    if (consent) {
      consent.scopes = [...new Set([...(consent.scopes || []), ...scopes])];
      consent.updated_at = nowIso();
    } else {
      consent = {
        id: crypto.randomUUID(),
        did,
        service_id,
        scopes: [...new Set(scopes)],
        created_at: nowIso()
      };
      store.consents.push(consent);
    }
    writeStore(store);
    dlog(`consent saved did=${did} service_id=${service_id} scopes=${consent.scopes.length}`);
    return res.json({ ok: true, consent });
  });

  app.delete("/v1/wallets/by-did/:did", (req, res) => {
    const did = decodeURIComponent(req.params.did);
    const store = readStore();
    const index = store.wallets.findIndex((w) => w.did === did);
    if (index === -1) {
      dlog(`delete wallet not found did=${did}`);
      return res.status(404).json({ error: "wallet_not_found" });
    }
    const deleted = store.wallets.splice(index, 1)[0];
    writeStore(store);
    dlog(`wallet deleted did=${did}`);
    return res.json({
      deleted: true,
      did: deleted.did,
      wallet_id: deleted.id
    });
  });

  return app;
}

function startWalletServer(options = {}) {
  const port = Number(options.port || PORT);
  const app = createWalletApp();
  const server = app.listen(port, () => {
    console.log(`wallet listening on http://localhost:${port} debug=${DEBUG_AUTH ? "on" : "off"}`);
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
