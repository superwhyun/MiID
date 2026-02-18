const crypto = require("crypto");
const { getDb } = require("./index");

// ============== Helpers ==============

function toJson(value) {
  return value ? JSON.stringify(value) : null;
}

function fromJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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

function hashScopes(scopes) {
  const normalized = [...new Set(scopes)].sort().join(" ");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

// ============== Challenges ==============

function insertChallenge(challenge) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO challenges (
      id, nonce, service_id, client_id, redirect_uri, scopes, requested_claims,
      state, risk_action, did_hint, require_user_approval, service_version, status, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    challenge.id,
    challenge.nonce,
    challenge.service_id,
    challenge.client_id,
    challenge.redirect_uri,
    toJson(challenge.scopes),
    toJson(challenge.requested_claims),
    challenge.state,
    challenge.risk_action,
    challenge.did_hint,
    challenge.require_user_approval ? 1 : 0,
    Number.isInteger(challenge.service_version) ? challenge.service_version : 1,
    challenge.status,
    challenge.expires_at,
    challenge.created_at
  );
  return challenge;
}

function findChallengeById(id) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM challenges WHERE id = ?").get(id);
  if (!row) return null;
  return {
    ...row,
    scopes: fromJson(row.scopes) || [],
    requested_claims: fromJson(row.requested_claims) || [],
    require_user_approval: Boolean(row.require_user_approval),
    service_version: Number.isInteger(row.service_version) ? row.service_version : 1
  };
}

function findPendingChallenges(did) {
  const db = getDb();
  const now = nowIso();
  const rows = db.prepare(`
    SELECT * FROM challenges
    WHERE (did_hint = ? OR did_hint IS NULL)
      AND status = 'pending'
      AND expires_at > ?
  `).all(did, now);
  return rows.map(row => ({
    ...row,
    scopes: fromJson(row.scopes) || [],
    requested_claims: fromJson(row.requested_claims) || [],
    require_user_approval: Boolean(row.require_user_approval),
    service_version: Number.isInteger(row.service_version) ? row.service_version : 1
  }));
}

function updateChallengeStatus(id, updates) {
  const db = getDb();
  const fields = [];
  const values = [];

  if (updates.status !== undefined) {
    fields.push("status = ?");
    values.push(updates.status);
  }
  if (updates.verified_at !== undefined) {
    fields.push("verified_at = ?");
    values.push(updates.verified_at);
  }
  if (updates.denied_at !== undefined) {
    fields.push("denied_at = ?");
    values.push(updates.denied_at);
  }
  if (updates.used_at !== undefined) {
    fields.push("used_at = ?");
    values.push(updates.used_at);
  }
  if (updates.authorization_code !== undefined) {
    fields.push("authorization_code = ?");
    values.push(updates.authorization_code);
  }

  if (fields.length === 0) return;
  values.push(id);

  db.prepare(`UPDATE challenges SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

// ============== Auth Codes ==============

function insertAuthCode(authCode) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO auth_codes (
      id, code, challenge_id, service_id, client_id, redirect_uri, did, subject_id,
      scopes, consent_required, missing_scopes, risk_action, requested_claims,
      approved_claims, profile_claims, wallet_url, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    authCode.id,
    authCode.code,
    authCode.challenge_id,
    authCode.service_id,
    authCode.client_id,
    authCode.redirect_uri,
    authCode.did,
    authCode.subject_id,
    toJson(authCode.scopes),
    authCode.consent_required ? 1 : 0,
    toJson(authCode.missing_scopes),
    authCode.risk_action,
    toJson(authCode.requested_claims),
    toJson(authCode.approved_claims),
    toJson(authCode.profile_claims),
    authCode.wallet_url,
    authCode.expires_at,
    authCode.created_at
  );
  return authCode;
}

function findAuthCodeByCode(code) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM auth_codes WHERE code = ?").get(code);
  if (!row) return null;
  return {
    ...row,
    scopes: fromJson(row.scopes) || [],
    missing_scopes: fromJson(row.missing_scopes) || [],
    requested_claims: fromJson(row.requested_claims) || [],
    approved_claims: fromJson(row.approved_claims) || [],
    profile_claims: fromJson(row.profile_claims),
    consent_required: Boolean(row.consent_required)
  };
}

function findLatestAuthCodeByChallengeId(challengeId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM auth_codes
    WHERE challenge_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(challengeId);
  if (!row) return null;
  return {
    ...row,
    scopes: fromJson(row.scopes) || [],
    missing_scopes: fromJson(row.missing_scopes) || [],
    requested_claims: fromJson(row.requested_claims) || [],
    approved_claims: fromJson(row.approved_claims) || [],
    profile_claims: fromJson(row.profile_claims),
    consent_required: Boolean(row.consent_required)
  };
}

function findApprovedAuthCodes(did) {
  const db = getDb();
  const now = nowIso();
  const rows = db.prepare(`
    SELECT * FROM auth_codes
    WHERE did = ? AND used_at IS NULL AND expires_at > ?
  `).all(did, now);
  return rows.map(row => ({
    ...row,
    scopes: fromJson(row.scopes) || [],
    missing_scopes: fromJson(row.missing_scopes) || [],
    requested_claims: fromJson(row.requested_claims) || [],
    approved_claims: fromJson(row.approved_claims) || [],
    profile_claims: fromJson(row.profile_claims),
    consent_required: Boolean(row.consent_required)
  }));
}

function updateAuthCodeUsed(code, usedAt) {
  const db = getDb();
  db.prepare("UPDATE auth_codes SET used_at = ? WHERE code = ?").run(usedAt, code);
}

// ============== Subjects ==============

function findOrCreateSubject(did, serviceId) {
  const db = getDb();
  const existing = db.prepare(
    "SELECT subject_id FROM subjects WHERE did = ? AND service_id = ?"
  ).get(did, serviceId);

  if (existing) return existing.subject_id;

  const subjectId = `sub_${crypto.randomUUID().replace(/-/g, "")}`;
  db.prepare(`
    INSERT INTO subjects (id, did, service_id, subject_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), did, serviceId, subjectId, nowIso());

  return subjectId;
}

// ============== Consents ==============

function insertConsent(consent) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO consents (
      id, service_id, subject_id, scopes, scope_hash, purpose, version, status, granted_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    consent.id,
    consent.service_id,
    consent.subject_id,
    toJson(consent.scopes),
    consent.scope_hash,
    consent.purpose,
    consent.version,
    consent.status,
    consent.granted_at,
    consent.expires_at
  );
  return consent;
}

function findConsentById(id) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM consents WHERE id = ?").get(id);
  if (!row) return null;
  return {
    ...row,
    scopes: fromJson(row.scopes) || []
  };
}

function findActiveConsents(serviceId, subjectId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM consents
    WHERE service_id = ? AND subject_id = ? AND status = 'active'
    ORDER BY version DESC
  `).all(serviceId, subjectId);
  return rows.map(row => ({
    ...row,
    scopes: fromJson(row.scopes) || []
  }));
}

function getMaxConsentVersion(serviceId, subjectId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(version) as max_version FROM consents
    WHERE service_id = ? AND subject_id = ?
  `).get(serviceId, subjectId);
  return row?.max_version || 0;
}

function updateConsentRevoked(id, revokedAt) {
  const db = getDb();
  db.prepare("UPDATE consents SET status = 'revoked', revoked_at = ? WHERE id = ?").run(revokedAt, id);
}

function upsertConsentForApproval(serviceId, subjectId, scopes, purpose = "wallet_approval") {
  const db = getDb();
  const normalizedScopes = [...new Set(scopes)];
  const version = getMaxConsentVersion(serviceId, subjectId) + 1;

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
    expires_at: null
  };

  insertConsent(consent);
  return consent;
}

// ============== Sessions ==============

function insertSession(session) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO sessions (
      id, service_id, subject_id, did, requested_claims, approved_claims,
      profile_claims, wallet_url, risk_level, access_token, refresh_token,
      scope, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    session.id,
    session.service_id,
    session.subject_id,
    session.did,
    toJson(session.requested_claims),
    toJson(session.approved_claims),
    toJson(session.profile_claims),
    session.wallet_url,
    session.risk_level,
    session.access_token,
    session.refresh_token,
    session.scope,
    session.expires_at,
    session.created_at
  );
  return session;
}

function insertSessionOrIgnore(session) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO sessions (
      id, service_id, subject_id, did, requested_claims, approved_claims,
      profile_claims, wallet_url, risk_level, access_token, refresh_token,
      scope, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    session.id,
    session.service_id,
    session.subject_id,
    session.did,
    toJson(session.requested_claims),
    toJson(session.approved_claims),
    toJson(session.profile_claims),
    session.wallet_url,
    session.risk_level,
    session.access_token,
    session.refresh_token,
    session.scope,
    session.expires_at,
    session.created_at
  );
  return result.changes > 0;
}

function findSessionById(id) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
  if (!row) return null;
  return {
    ...row,
    requested_claims: fromJson(row.requested_claims) || [],
    approved_claims: fromJson(row.approved_claims) || [],
    profile_claims: fromJson(row.profile_claims)
  };
}

function findSessionByAccessToken(accessToken) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE access_token = ?").get(accessToken);
  if (!row) return null;
  return {
    ...row,
    requested_claims: fromJson(row.requested_claims) || [],
    approved_claims: fromJson(row.approved_claims) || [],
    profile_claims: fromJson(row.profile_claims)
  };
}

function findSessionsByDid(did) {
  const db = getDb();
  const now = nowIso();
  const rows = db.prepare(`
    SELECT * FROM sessions
    WHERE did = ? AND revoked_at IS NULL AND expires_at > ?
  `).all(did, now);
  return rows.map(row => ({
    ...row,
    requested_claims: fromJson(row.requested_claims) || [],
    approved_claims: fromJson(row.approved_claims) || [],
    profile_claims: fromJson(row.profile_claims)
  }));
}

function findReusableSession(serviceId, did, scopes) {
  const db = getDb();
  const now = nowIso();
  const rows = db.prepare(`
    SELECT * FROM sessions
    WHERE service_id = ? AND did = ? AND revoked_at IS NULL AND expires_at > ?
  `).all(serviceId, did, now);

  const scopeSet = new Set(scopes);
  for (const row of rows) {
    const sessionScopes = row.scope.split(" ");
    if (scopes.every(s => sessionScopes.includes(s))) {
      return {
        ...row,
        requested_claims: fromJson(row.requested_claims) || [],
        approved_claims: fromJson(row.approved_claims) || [],
        profile_claims: fromJson(row.profile_claims)
      };
    }
  }
  return null;
}

function findExistingSession(serviceId, subjectId, scope, riskLevel) {
  const db = getDb();
  const now = nowIso();
  const row = db.prepare(`
    SELECT * FROM sessions
    WHERE service_id = ? AND subject_id = ? AND scope = ? AND risk_level = ?
      AND revoked_at IS NULL AND expires_at > ?
  `).get(serviceId, subjectId, scope, riskLevel, now);
  if (!row) return null;
  return {
    ...row,
    requested_claims: fromJson(row.requested_claims) || [],
    approved_claims: fromJson(row.approved_claims) || [],
    profile_claims: fromJson(row.profile_claims)
  };
}

function findActiveSessionByDidService(serviceId, did) {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM sessions
    WHERE service_id = ? AND did = ? AND revoked_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get(serviceId, did);
  if (!row) return null;
  return {
    ...row,
    requested_claims: fromJson(row.requested_claims) || [],
    approved_claims: fromJson(row.approved_claims) || [],
    profile_claims: fromJson(row.profile_claims)
  };
}

function updateSessionRevoked(id, revokedAt) {
  const db = getDb();
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").run(revokedAt, id);
}

function updateSessionClaims(id, updates) {
  const db = getDb();
  const fields = [];
  const values = [];

  if (updates.profile_claims !== undefined) {
    fields.push("profile_claims = ?");
    values.push(toJson(updates.profile_claims));
  }
  if (updates.approved_claims !== undefined) {
    fields.push("approved_claims = ?");
    values.push(toJson(updates.approved_claims));
  }
  if (updates.requested_claims !== undefined) {
    fields.push("requested_claims = ?");
    values.push(toJson(updates.requested_claims));
  }
  if (updates.wallet_url !== undefined) {
    fields.push("wallet_url = ?");
    values.push(updates.wallet_url);
  }

  if (fields.length === 0) return;
  values.push(id);

  db.prepare(`UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

function updateSessionForTokenExchange(id, updates) {
  const db = getDb();
  db.prepare(`
    UPDATE sessions
    SET
      subject_id = ?,
      requested_claims = ?,
      approved_claims = ?,
      profile_claims = ?,
      wallet_url = ?,
      risk_level = ?,
      access_token = ?,
      refresh_token = ?,
      scope = ?,
      expires_at = ?,
      revoked_at = NULL,
      created_at = ?
    WHERE id = ?
  `).run(
    updates.subject_id,
    toJson(updates.requested_claims),
    toJson(updates.approved_claims),
    toJson(updates.profile_claims),
    updates.wallet_url,
    updates.risk_level,
    updates.access_token,
    updates.refresh_token,
    updates.scope,
    updates.expires_at,
    updates.created_at,
    id
  );
}

function revokeSessionsByConsent(serviceId, subjectId) {
  const db = getDb();
  const now = nowIso();
  const sessions = db.prepare(`
    SELECT id, did FROM sessions
    WHERE service_id = ? AND subject_id = ? AND revoked_at IS NULL
  `).all(serviceId, subjectId);

  db.prepare(`
    UPDATE sessions SET revoked_at = ?
    WHERE service_id = ? AND subject_id = ? AND revoked_at IS NULL
  `).run(now, serviceId, subjectId);

  return sessions;
}

function revokeOtherActiveSessionsByDidService(serviceId, did, keepSessionId) {
  const db = getDb();
  const now = nowIso();
  const sessions = db.prepare(`
    SELECT id, did, service_id, subject_id FROM sessions
    WHERE service_id = ? AND did = ? AND revoked_at IS NULL AND id != ?
  `).all(serviceId, did, keepSessionId);

  db.prepare(`
    UPDATE sessions SET revoked_at = ?
    WHERE service_id = ? AND did = ? AND revoked_at IS NULL AND id != ?
  `).run(now, serviceId, did, keepSessionId);

  return sessions;
}

module.exports = {
  // Helpers
  nowIso,
  addMinutes,
  addDays,
  randomToken,
  hashScopes,
  toJson,
  fromJson,

  // Challenges
  insertChallenge,
  findChallengeById,
  findPendingChallenges,
  updateChallengeStatus,

  // Auth Codes
  insertAuthCode,
  findAuthCodeByCode,
  findLatestAuthCodeByChallengeId,
  findApprovedAuthCodes,
  updateAuthCodeUsed,

  // Subjects
  findOrCreateSubject,

  // Consents
  insertConsent,
  findConsentById,
  findActiveConsents,
  getMaxConsentVersion,
  updateConsentRevoked,
  upsertConsentForApproval,

  // Sessions
  insertSession,
  insertSessionOrIgnore,
  findSessionById,
  findSessionByAccessToken,
  findSessionsByDid,
  findReusableSession,
  findExistingSession,
  findActiveSessionByDidService,
  updateSessionRevoked,
  updateSessionClaims,
  updateSessionForTokenExchange,
  revokeSessionsByConsent,
  revokeOtherActiveSessionsByDidService
};
