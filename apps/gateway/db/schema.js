function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS challenges (
      id TEXT PRIMARY KEY,
      nonce TEXT NOT NULL,
      service_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      scopes TEXT NOT NULL,
      requested_claims TEXT,
      state TEXT,
      risk_action TEXT,
      did_hint TEXT,
      require_user_approval INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending',
      verified_at TEXT,
      denied_at TEXT,
      authorization_code TEXT,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_challenges_did_hint ON challenges(did_hint);
    CREATE INDEX IF NOT EXISTS idx_challenges_status_expires ON challenges(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_challenges_client_id ON challenges(client_id);

    CREATE TABLE IF NOT EXISTS auth_codes (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      challenge_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      did TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      scopes TEXT NOT NULL,
      consent_required INTEGER DEFAULT 0,
      missing_scopes TEXT,
      risk_action TEXT,
      requested_claims TEXT,
      approved_claims TEXT,
      profile_claims TEXT,
      wallet_url TEXT,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_auth_codes_code ON auth_codes(code);
    CREATE INDEX IF NOT EXISTS idx_auth_codes_did ON auth_codes(did);
    CREATE INDEX IF NOT EXISTS idx_auth_codes_challenge_id ON auth_codes(challenge_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_auth_codes_challenge_id ON auth_codes(challenge_id);

    CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      service_id TEXT NOT NULL,
      subject_id TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(did, service_id)
    );

    CREATE INDEX IF NOT EXISTS idx_subjects_did_service ON subjects(did, service_id);

    CREATE TABLE IF NOT EXISTS consents (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      scopes TEXT NOT NULL,
      scope_hash TEXT NOT NULL,
      purpose TEXT,
      version INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active',
      granted_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_consents_service_subject ON consents(service_id, subject_id);
    CREATE INDEX IF NOT EXISTS idx_consents_service_subject_status ON consents(service_id, subject_id, status);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      did TEXT NOT NULL,
      requested_claims TEXT,
      approved_claims TEXT,
      profile_claims TEXT,
      wallet_url TEXT,
      risk_level TEXT DEFAULT 'normal',
      access_token TEXT UNIQUE NOT NULL,
      refresh_token TEXT UNIQUE NOT NULL,
      scope TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_access_token ON sessions(access_token);
    CREATE INDEX IF NOT EXISTS idx_sessions_did ON sessions(did);
    CREATE INDEX IF NOT EXISTS idx_sessions_service_did ON sessions(service_id, did);
    CREATE INDEX IF NOT EXISTS idx_sessions_service_subject ON sessions(service_id, subject_id);
  `);

  const challengeColumns = db.prepare("PRAGMA table_info(challenges)").all();
  const hasServiceVersion = challengeColumns.some((col) => col.name === "service_version");
  if (!hasServiceVersion) {
    db.exec("ALTER TABLE challenges ADD COLUMN service_version INTEGER DEFAULT 1");
  }

  // One-time cleanup: keep only latest active session per (service_id, did).
  db.exec(`
    UPDATE sessions
    SET revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE revoked_at IS NULL
      AND id IN (
        SELECT older.id
        FROM sessions AS older
        JOIN sessions AS newer
          ON older.service_id = newer.service_id
         AND older.did = newer.did
         AND older.revoked_at IS NULL
         AND newer.revoked_at IS NULL
         AND (
           older.created_at < newer.created_at
           OR (older.created_at = newer.created_at AND older.id < newer.id)
         )
      );
  `);

  // Root invariant: only one active session can exist per (service_id, did).
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_active_did_service
    ON sessions(service_id, did)
    WHERE revoked_at IS NULL;
  `);
}

module.exports = { initializeSchema };
