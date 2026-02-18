const { getDb } = require("./index");

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1시간
const RETENTION_DAYS = {
  challenges: 1,   // 만료 후 1일 보관
  authCodes: 1,    // 사용/만료 후 1일 보관
  sessions: 7,     // 취소/만료 후 7일 보관
  consents: 30     // 취소 후 30일 보관
};

let cleanupTimer = null;

function cleanupExpiredRecords() {
  const db = getDb();
  const now = new Date().toISOString();

  const results = {
    challenges: 0,
    authCodes: 0,
    sessions: 0,
    consents: 0
  };

  // 만료된 challenges 삭제 (status가 pending이 아니거나 1일 이상 지난 것)
  const challengeResult = db.prepare(`
    DELETE FROM challenges
    WHERE expires_at < datetime('now', '-${RETENTION_DAYS.challenges} days')
  `).run();
  results.challenges = challengeResult.changes;

  // 사용/만료된 auth_codes 삭제
  const authCodeResult = db.prepare(`
    DELETE FROM auth_codes
    WHERE (used_at IS NOT NULL OR expires_at < datetime('now'))
      AND created_at < datetime('now', '-${RETENTION_DAYS.authCodes} days')
  `).run();
  results.authCodes = authCodeResult.changes;

  // 취소/만료된 sessions 삭제
  const sessionResult = db.prepare(`
    DELETE FROM sessions
    WHERE (revoked_at IS NOT NULL OR expires_at < datetime('now'))
      AND created_at < datetime('now', '-${RETENTION_DAYS.sessions} days')
  `).run();
  results.sessions = sessionResult.changes;

  // 취소된 consents 삭제
  const consentResult = db.prepare(`
    DELETE FROM consents
    WHERE revoked_at IS NOT NULL
      AND revoked_at < datetime('now', '-${RETENTION_DAYS.consents} days')
  `).run();
  results.consents = consentResult.changes;

  const total = results.challenges + results.authCodes + results.sessions + results.consents;
  if (total > 0) {
    console.log(`[gateway] cleanup: deleted ${total} expired records`, results);
  }

  return results;
}

function startCleanupScheduler() {
  // 서버 시작 시 즉시 클린업 실행
  cleanupExpiredRecords();

  // 주기적 클린업 스케줄링
  cleanupTimer = setInterval(() => {
    cleanupExpiredRecords();
  }, CLEANUP_INTERVAL_MS);

  console.log(`[gateway] cleanup scheduler started (interval: ${CLEANUP_INTERVAL_MS / 1000}s)`);
}

function stopCleanupScheduler() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

module.exports = {
  cleanupExpiredRecords,
  startCleanupScheduler,
  stopCleanupScheduler,
  RETENTION_DAYS
};
