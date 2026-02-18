#!/usr/bin/env node

/**
 * gateway.json → SQLite 마이그레이션 스크립트
 *
 * 사용법: node apps/gateway/migrations/migrate-json-to-sqlite.js
 */

const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "..", "..", "data");
const JSON_FILE = path.join(DATA_DIR, "gateway.json");
const DB_FILE = path.join(DATA_DIR, "gateway.db");
const BACKUP_FILE = path.join(DATA_DIR, "gateway.json.backup");

function toJson(value) {
  return value ? JSON.stringify(value) : null;
}

function createSchema(db) {
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
}

function migrateChallenge(db, record) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO challenges (
      id, nonce, service_id, client_id, redirect_uri, scopes, requested_claims,
      state, risk_action, did_hint, require_user_approval, status,
      verified_at, denied_at, authorization_code, expires_at, used_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    record.id,
    record.nonce,
    record.service_id,
    record.client_id,
    record.redirect_uri,
    toJson(record.scopes || []),
    toJson(record.requested_claims || []),
    record.state || null,
    record.risk_action || null,
    record.did_hint || null,
    record.require_user_approval ? 1 : 0,
    record.status || "pending",
    record.verified_at || null,
    record.denied_at || null,
    record.authorization_code || null,
    record.expires_at,
    record.used_at || null,
    record.created_at
  );
}

function migrateAuthCode(db, record) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO auth_codes (
      id, code, challenge_id, service_id, client_id, redirect_uri, did, subject_id,
      scopes, consent_required, missing_scopes, risk_action, requested_claims,
      approved_claims, profile_claims, wallet_url, expires_at, used_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    record.id,
    record.code,
    record.challenge_id,
    record.service_id,
    record.client_id,
    record.redirect_uri,
    record.did,
    record.subject_id,
    toJson(record.scopes || []),
    record.consent_required ? 1 : 0,
    toJson(record.missing_scopes || []),
    record.risk_action || null,
    toJson(record.requested_claims || []),
    toJson(record.approved_claims || []),
    toJson(record.profile_claims || null),
    record.wallet_url || null,
    record.expires_at,
    record.used_at || null,
    record.created_at
  );
}

function migrateSubject(db, record) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO subjects (id, did, service_id, subject_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(
    record.id,
    record.did,
    record.service_id,
    record.subject_id,
    record.created_at
  );
}

function migrateConsent(db, record) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO consents (
      id, service_id, subject_id, scopes, scope_hash, purpose, version, status,
      granted_at, expires_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    record.id,
    record.service_id,
    record.subject_id,
    toJson(record.scopes || []),
    record.scope_hash,
    record.purpose || null,
    record.version || 1,
    record.status || "active",
    record.granted_at,
    record.expires_at || null,
    record.revoked_at || null
  );
}

function migrateSession(db, record) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO sessions (
      id, service_id, subject_id, did, requested_claims, approved_claims,
      profile_claims, wallet_url, risk_level, access_token, refresh_token,
      scope, expires_at, revoked_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    record.id,
    record.service_id,
    record.subject_id,
    record.did,
    toJson(record.requested_claims || []),
    toJson(record.approved_claims || []),
    toJson(record.profile_claims || null),
    record.wallet_url || null,
    record.risk_level || "normal",
    record.access_token,
    record.refresh_token,
    record.scope,
    record.expires_at,
    record.revoked_at || null,
    record.created_at
  );
}

function migrate() {
  console.log("=== gateway.json → SQLite 마이그레이션 시작 ===\n");

  // 1. JSON 파일 존재 확인
  if (!fs.existsSync(JSON_FILE)) {
    console.log("gateway.json 파일이 없습니다. 새 DB가 생성됩니다.");
    const db = new Database(DB_FILE);
    db.pragma("journal_mode = WAL");
    createSchema(db);
    db.close();
    console.log("✓ 새 gateway.db 생성 완료");
    return;
  }

  // 2. 기존 DB 파일 존재 시 삭제 여부 확인
  if (fs.existsSync(DB_FILE)) {
    console.log("⚠ gateway.db가 이미 존재합니다. 기존 DB를 삭제하고 새로 마이그레이션합니다.");
    fs.unlinkSync(DB_FILE);
    // WAL 파일도 삭제
    if (fs.existsSync(DB_FILE + "-wal")) fs.unlinkSync(DB_FILE + "-wal");
    if (fs.existsSync(DB_FILE + "-shm")) fs.unlinkSync(DB_FILE + "-shm");
  }

  // 3. JSON 파일 백업
  fs.copyFileSync(JSON_FILE, BACKUP_FILE);
  console.log(`✓ 백업 생성: ${BACKUP_FILE}`);

  // 4. JSON 데이터 읽기
  const jsonData = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
  console.log(`\n원본 데이터:`);
  console.log(`  - challenges: ${(jsonData.challenges || []).length}`);
  console.log(`  - authCodes: ${(jsonData.authCodes || []).length}`);
  console.log(`  - subjects: ${(jsonData.subjects || []).length}`);
  console.log(`  - consents: ${(jsonData.consents || []).length}`);
  console.log(`  - sessions: ${(jsonData.sessions || []).length}`);

  // 5. DB 생성 및 스키마 초기화
  const db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");
  createSchema(db);

  // 6. 마이그레이션 실행 (트랜잭션)
  const stats = {
    challenges: { success: 0, error: 0 },
    authCodes: { success: 0, error: 0 },
    subjects: { success: 0, error: 0 },
    consents: { success: 0, error: 0 },
    sessions: { success: 0, error: 0 }
  };

  const transaction = db.transaction(() => {
    // Challenges
    for (const record of jsonData.challenges || []) {
      try {
        migrateChallenge(db, record);
        stats.challenges.success++;
      } catch (err) {
        stats.challenges.error++;
        console.error(`  ✗ challenge ${record.id}: ${err.message}`);
      }
    }

    // Auth Codes
    for (const record of jsonData.authCodes || []) {
      try {
        migrateAuthCode(db, record);
        stats.authCodes.success++;
      } catch (err) {
        stats.authCodes.error++;
        console.error(`  ✗ authCode ${record.id}: ${err.message}`);
      }
    }

    // Subjects
    for (const record of jsonData.subjects || []) {
      try {
        migrateSubject(db, record);
        stats.subjects.success++;
      } catch (err) {
        stats.subjects.error++;
        console.error(`  ✗ subject ${record.id}: ${err.message}`);
      }
    }

    // Consents
    for (const record of jsonData.consents || []) {
      try {
        migrateConsent(db, record);
        stats.consents.success++;
      } catch (err) {
        stats.consents.error++;
        console.error(`  ✗ consent ${record.id}: ${err.message}`);
      }
    }

    // Sessions
    for (const record of jsonData.sessions || []) {
      try {
        migrateSession(db, record);
        stats.sessions.success++;
      } catch (err) {
        stats.sessions.error++;
        console.error(`  ✗ session ${record.id}: ${err.message}`);
      }
    }
  });

  transaction();

  // 7. 결과 출력
  console.log(`\n마이그레이션 결과:`);
  console.log(`  - challenges: ${stats.challenges.success} 성공, ${stats.challenges.error} 실패`);
  console.log(`  - authCodes: ${stats.authCodes.success} 성공, ${stats.authCodes.error} 실패`);
  console.log(`  - subjects: ${stats.subjects.success} 성공, ${stats.subjects.error} 실패`);
  console.log(`  - consents: ${stats.consents.success} 성공, ${stats.consents.error} 실패`);
  console.log(`  - sessions: ${stats.sessions.success} 성공, ${stats.sessions.error} 실패`);

  // 8. DB에서 레코드 수 확인
  const dbCounts = {
    challenges: db.prepare("SELECT COUNT(*) as cnt FROM challenges").get().cnt,
    authCodes: db.prepare("SELECT COUNT(*) as cnt FROM auth_codes").get().cnt,
    subjects: db.prepare("SELECT COUNT(*) as cnt FROM subjects").get().cnt,
    consents: db.prepare("SELECT COUNT(*) as cnt FROM consents").get().cnt,
    sessions: db.prepare("SELECT COUNT(*) as cnt FROM sessions").get().cnt
  };

  console.log(`\nDB 레코드 수 확인:`);
  console.log(`  - challenges: ${dbCounts.challenges}`);
  console.log(`  - auth_codes: ${dbCounts.authCodes}`);
  console.log(`  - subjects: ${dbCounts.subjects}`);
  console.log(`  - consents: ${dbCounts.consents}`);
  console.log(`  - sessions: ${dbCounts.sessions}`);

  db.close();

  // 9. 원본 파일 이름 변경
  const migratedFile = JSON_FILE + ".migrated";
  fs.renameSync(JSON_FILE, migratedFile);
  console.log(`\n✓ 원본 파일 이름 변경: ${migratedFile}`);

  // 10. 파일 크기 비교
  const jsonSize = fs.statSync(migratedFile).size;
  const dbSize = fs.statSync(DB_FILE).size;
  console.log(`\n파일 크기:`);
  console.log(`  - gateway.json.migrated: ${(jsonSize / 1024).toFixed(1)} KB`);
  console.log(`  - gateway.db: ${(dbSize / 1024).toFixed(1)} KB`);

  console.log(`\n=== 마이그레이션 완료 ===`);
}

migrate();
