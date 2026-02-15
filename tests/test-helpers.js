/**
 * MiID E2E Test Helpers
 */

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:14000';
const WALLET_URL = process.env.WALLET_URL || 'http://localhost:17000';
const DEFAULT_SERVICE_ID = 'service-test';
const DEFAULT_CLIENT_ID = 'web-client';
const DEFAULT_REDIRECT_URI = 'https://service-test.local/callback';
const DEFAULT_SCOPES = ['profile', 'email'];

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
};

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected "${expected}", got "${actual}"`);
  }
}

function assertNotNull(value, message) {
  if (value === null || value === undefined) {
    throw new Error(`${message}: value is null or undefined`);
  }
}

function assertTrue(condition, message) {
  if (!condition) throw new Error(`${message}: condition is false`);
}

function logStep(step, description) {
  console.log(`${colors.cyan}[Step ${step}]${colors.reset} ${description}`);
}

function logSuccess(message) {
  console.log(`${colors.green}  [OK]${colors.reset} ${message}`);
}

function logError(message) {
  console.log(`${colors.red}  [FAIL]${colors.reset} ${message}`);
}

function logInfo(message) {
  console.log(`${colors.dim}  [INFO]${colors.reset} ${message}`);
}

function logTestStart(testName) {
  console.log(`\n${colors.blue}========================================${colors.reset}`);
  console.log(`${colors.blue}TEST: ${testName}${colors.reset}`);
  console.log(`${colors.blue}========================================${colors.reset}\n`);
}

function logTestEnd(testName, success, duration) {
  const status = success ? `${colors.green}PASSED${colors.reset}` : `${colors.red}FAILED${colors.reset}`;
  console.log(`\n${colors.blue}========================================${colors.reset}`);
  console.log(`${testName}: ${status} (${duration}ms)`);
  console.log(`${colors.blue}========================================${colors.reset}\n`);
}

async function httpGet(url, headers = {}) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', ...headers }
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data, response };
}

async function httpPost(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data, response };
}

async function httpDelete(url, body = {}, headers = {}) {
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data, response };
}

async function createWallet(name = 'test-wallet') {
  const result = await httpPost(`${WALLET_URL}/v1/wallets`, { name });
  if (result.status !== 201) throw new Error(`Failed to create wallet: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function signChallenge(did, challengeId, nonce, audience, expiresAt) {
  const result = await httpPost(`${WALLET_URL}/v1/wallets/sign`, {
    did,
    challenge_id: challengeId,
    nonce,
    audience,
    expires_at: expiresAt
  });
  if (result.status !== 200) throw new Error(`Failed to sign challenge: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function createChallenge(options = {}) {
  const {
    serviceId = DEFAULT_SERVICE_ID,
    clientId = DEFAULT_CLIENT_ID,
    redirectUri = DEFAULT_REDIRECT_URI,
    scopes = DEFAULT_SCOPES,
    didHint = null
  } = options;

  const result = await httpPost(`${GATEWAY_URL}/v1/auth/challenge`, {
    service_id: serviceId,
    client_id: clientId,
    redirect_uri: redirectUri,
    scopes,
    did_hint: didHint,
    require_user_approval: true
  });

  if (result.status !== 201) throw new Error(`Failed to create challenge: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function getChallengeStatus(challengeId) {
  return await httpGet(`${GATEWAY_URL}/v1/auth/challenges/${challengeId}/status`);
}

async function approveChallenge(challengeId, did, signature) {
  return await httpPost(`${GATEWAY_URL}/v1/wallet/challenges/${challengeId}/approve`, {
    did,
    signature,
    wallet_url: WALLET_URL
  });
}

async function denyChallenge(challengeId, did) {
  return await httpPost(`${GATEWAY_URL}/v1/wallet/challenges/${challengeId}/deny`, { did });
}

async function exchangeToken(code, clientId = DEFAULT_CLIENT_ID, redirectUri = DEFAULT_REDIRECT_URI) {
  return await httpPost(`${GATEWAY_URL}/v1/token/exchange`, {
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri
  });
}

async function getWalletSessions(did) {
  return await httpGet(`${GATEWAY_URL}/v1/wallet/sessions?did=${encodeURIComponent(did)}`);
}

async function revokeSession(sessionId, did) {
  return await httpDelete(`${GATEWAY_URL}/v1/wallet/sessions/${sessionId}`, { did });
}

async function getServiceProfile(serviceId, accessToken) {
  return await httpGet(`${GATEWAY_URL}/v1/services/${serviceId}/profile`, {
    'Authorization': `Bearer ${accessToken}`
  });
}

async function runTest(testName, testFn) {
  logTestStart(testName);
  const startTime = Date.now();
  let success = false;
  try {
    await testFn();
    success = true;
    logTestEnd(testName, true, Date.now() - startTime);
  } catch (error) {
    logError(error.message);
    logTestEnd(testName, false, Date.now() - startTime);
    throw error;
  }
  return success;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkServerHealth(url) {
  try {
    const result = await httpGet(`${url}/health`);
    return result.status === 200 && result.data?.ok;
  } catch { return false; }
}

async function waitForServers(timeout = 30000) {
  const startTime = Date.now();
  const servers = [
    { url: GATEWAY_URL, name: 'Gateway' },
    { url: WALLET_URL, name: 'Wallet' }
  ];

  console.log('Checking server health...');
  while (Date.now() - startTime < timeout) {
    let allReady = true;
    for (const server of servers) {
      if (!(await checkServerHealth(server.url))) {
        allReady = false;
        break;
      }
    }
    if (allReady) {
      logSuccess('All servers are ready');
      return true;
    }
    await sleep(1000);
  }
  throw new Error('Timeout waiting for servers');
}

module.exports = {
  GATEWAY_URL, WALLET_URL, DEFAULT_SERVICE_ID, DEFAULT_CLIENT_ID, DEFAULT_REDIRECT_URI, DEFAULT_SCOPES,
  colors, assertEqual, assertNotNull, assertTrue,
  logStep, logSuccess, logError, logInfo, logTestStart, logTestEnd,
  httpGet, httpPost, httpDelete,
  createWallet, signChallenge, createChallenge, getChallengeStatus,
  approveChallenge, denyChallenge, exchangeToken, getWalletSessions, revokeSession, getServiceProfile,
  runTest, sleep, checkServerHealth, waitForServers
};
