#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

GATEWAY_URL="${GATEWAY_URL:-http://localhost:14000}"
WALLET_URL="${WALLET_URL:-http://localhost:17000}"
SERVICE_ID="${SERVICE_ID:-service-test}"
CLIENT_ID="${CLIENT_ID:-web-client}"
REDIRECT_URI="${REDIRECT_URI:-https://service-test.local/callback}"
SCOPES="${SCOPES:-profile,email}"

if [ ! -f "data/wallet.json" ]; then
  echo "error: data/wallet.json not found. run npm run dev:desktop first."
  exit 1
fi

SIGN_SECRET=""
if [ -f "data/menubar-runtime.json" ]; then
  SIGN_SECRET="$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('data/menubar-runtime.json','utf8'));console.log(j.wallet_sign_secret||'')")"
fi
if [ -z "$SIGN_SECRET" ]; then
  echo "error: approval automation is disabled. run desktop with MIID_TEST_HOOKS=1 to enable test hooks."
  exit 1
fi

DID="$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('data/wallet.json','utf8'));if(!j.wallets||!j.wallets[0]){process.exit(1)};console.log(j.wallets[0].did)")"
if [ -z "$DID" ]; then
  echo "error: wallet DID not found."
  exit 1
fi

SCOPES_JSON="$(node -e "const x=process.argv[1].split(',').map(v=>v.trim()).filter(Boolean);process.stdout.write(JSON.stringify(x));" "$SCOPES")"

echo "[1/6] create challenge"
CHALLENGE_JSON="$(curl -sS -X POST "${GATEWAY_URL}/v1/auth/challenge" \
  -H 'content-type: application/json' \
  -d "{\"service_id\":\"${SERVICE_ID}\",\"client_id\":\"${CLIENT_ID}\",\"redirect_uri\":\"${REDIRECT_URI}\",\"scopes\":${SCOPES_JSON},\"did_hint\":\"${DID}\"}")"
CHALLENGE_ID="$(echo "$CHALLENGE_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).challenge_id")"
echo "challenge_id=${CHALLENGE_ID}"

echo "[2/6] check pending list"
PENDING_JSON="$(curl -sS "${GATEWAY_URL}/v1/wallet/challenges?did=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$DID")")"
PENDING_COUNT="$(echo "$PENDING_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).challenges.length")"
echo "pending_count=${PENDING_COUNT}"

echo "[3/6] approve challenge"
SIGN_HEADERS=(-H 'content-type: application/json')
if [ -n "$SIGN_SECRET" ]; then
  SIGN_HEADERS+=(-H "x-wallet-sign-secret: ${SIGN_SECRET}")
fi
SIGN_JSON="$(curl -sS -X POST "${WALLET_URL}/v1/wallets/sign" \
  "${SIGN_HEADERS[@]}" \
  -d "{\"did\":\"${DID}\",\"challenge_id\":\"${CHALLENGE_ID}\",\"nonce\":\"$(echo "$CHALLENGE_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).nonce")\",\"audience\":\"${CLIENT_ID}\",\"expires_at\":\"$(echo "$CHALLENGE_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).expires_at")\"}")"
SIGNATURE="$(echo "$SIGN_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).signature")"
if [ -z "${SIGNATURE}" ] || [ "${SIGNATURE}" = "undefined" ]; then
  echo "wallet sign failed: ${SIGN_JSON}"
  exit 1
fi
APPROVE_JSON="$(curl -sS -X POST "${GATEWAY_URL}/v1/wallet/challenges/${CHALLENGE_ID}/approve" \
  -H 'content-type: application/json' \
  -d "{\"did\":\"${DID}\",\"wallet_url\":\"${WALLET_URL}\",\"signature\":\"${SIGNATURE}\"}")"
AUTH_CODE="$(echo "$APPROVE_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).authorization_code")"
if [ -z "${AUTH_CODE}" ] || [ "${AUTH_CODE}" = "undefined" ]; then
  echo "approve failed: ${APPROVE_JSON}"
  exit 1
fi
echo "auth_code=${AUTH_CODE}"

echo "[4/6] verify challenge status"
STATUS_JSON="$(curl -sS "${GATEWAY_URL}/v1/auth/challenges/${CHALLENGE_ID}/status")"
STATUS="$(echo "$STATUS_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).status")"
echo "status=${STATUS}"

echo "[5/5] approval complete (waiting service finalize)"
echo "approved auth_code=${AUTH_CODE}"
echo "next: npm run test:finalize"
