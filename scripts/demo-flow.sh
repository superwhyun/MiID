#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

WALLET_PORT="${WALLET_PORT:-17100}"
GATEWAY_PORT="${GATEWAY_PORT:-14100}"
WALLET_URL="http://localhost:${WALLET_PORT}"
GATEWAY_URL="http://localhost:${GATEWAY_PORT}"
SERVICE_ID="${SERVICE_ID:-service-test}"
CLIENT_ID="${CLIENT_ID:-web-client}"
CLIENT_SECRET="${CLIENT_SECRET:-dev-service-secret}"
REDIRECT_URI="${REDIRECT_URI:-https://service-test.local/callback}"
WALLET_SIGN_SECRET="${WALLET_SIGN_SECRET:-demo-wallet-secret}"

if [ -f "data/gateway.json" ]; then
  rm -f "data/gateway.json"
fi
if [ -f "data/wallet.json" ]; then
  rm -f "data/wallet.json"
fi

echo "[1/8] starting wallet + gateway"
WALLET_PORT="$WALLET_PORT" WALLET_SIGN_SECRET="$WALLET_SIGN_SECRET" node apps/wallet/server.js >/tmp/miid-wallet.log 2>&1 &
WALLET_PID=$!
GATEWAY_PORT="$GATEWAY_PORT" SERVICE_ID="$SERVICE_ID" SERVICE_CLIENT_ID="$CLIENT_ID" SERVICE_CLIENT_SECRET="$CLIENT_SECRET" SERVICE_REDIRECT_URI="$REDIRECT_URI" node apps/gateway/server.js >/tmp/miid-gateway.log 2>&1 &
GATEWAY_PID=$!

cleanup() {
  kill "$WALLET_PID" "$GATEWAY_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sleep 1

echo "[2/8] create wallet"
WALLET_JSON="$(curl -sS -X POST "${WALLET_URL}/v1/wallets" -H 'content-type: application/json' -d '{"name":"alice"}')"
DID="$(echo "$WALLET_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).did")"
echo "did=${DID}"

echo "[3/8] create challenge for ${SERVICE_ID}"
CHALLENGE_JSON="$(curl -sS -X POST "${GATEWAY_URL}/v1/auth/challenge" \
  -H 'content-type: application/json' \
  -H "x-client-id: ${CLIENT_ID}" \
  -H "x-client-secret: ${CLIENT_SECRET}" \
  -d "{\"service_id\":\"${SERVICE_ID}\",\"client_id\":\"${CLIENT_ID}\",\"redirect_uri\":\"${REDIRECT_URI}\",\"scopes\":[\"profile\",\"email\"],\"did_hint\":\"${DID}\"}")"
if echo "$CHALLENGE_JSON" | rg -q '"error"'; then
  echo "challenge failed: $CHALLENGE_JSON"
  exit 1
fi
CHALLENGE_ID="$(echo "$CHALLENGE_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).challenge_id")"
NONCE="$(echo "$CHALLENGE_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).nonce")"
EXPIRES_AT="$(echo "$CHALLENGE_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).expires_at")"

echo "[4/8] user approves challenge (wallet-confirmed route)"
SIGN_JSON="$(curl -sS -X POST "${WALLET_URL}/v1/wallets/sign" \
  -H 'content-type: application/json' \
  -H "x-wallet-sign-secret: ${WALLET_SIGN_SECRET}" \
  -d "{\"did\":\"${DID}\",\"challenge_id\":\"${CHALLENGE_ID}\",\"nonce\":\"${NONCE}\",\"audience\":\"${CLIENT_ID}\",\"expires_at\":\"${EXPIRES_AT}\"}")"
if echo "$SIGN_JSON" | rg -q '"error"'; then
  echo "wallet sign failed: $SIGN_JSON"
  exit 1
fi
SIGNATURE="$(echo "$SIGN_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).signature")"
VERIFY_JSON="$(curl -sS -X POST "${GATEWAY_URL}/v1/wallet/challenges/${CHALLENGE_ID}/approve" \
  -H 'content-type: application/json' \
  -d "{\"did\":\"${DID}\",\"wallet_url\":\"${WALLET_URL}\",\"signature\":\"${SIGNATURE}\"}")"
if echo "$VERIFY_JSON" | rg -q '"error"'; then
  echo "approve failed: $VERIFY_JSON"
  exit 1
fi
AUTH_CODE="$(echo "$VERIFY_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).authorization_code")"
SUBJECT_ID="$(echo "$VERIFY_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).subject_id")"
CONSENT_REQUIRED="$(echo "$VERIFY_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).consent_required")"
echo "consent_required=${CONSENT_REQUIRED}"

echo "[5/8] consent is recorded by approve flow"
echo "subject_id=${SUBJECT_ID}"

echo "[6/8] exchange token"
TOKEN_JSON="$(curl -sS -X POST "${GATEWAY_URL}/v1/token/exchange" \
  -H 'content-type: application/json' \
  -H "x-client-id: ${CLIENT_ID}" \
  -H "x-client-secret: ${CLIENT_SECRET}" \
  -d "{\"grant_type\":\"authorization_code\",\"code\":\"${AUTH_CODE}\",\"client_id\":\"${CLIENT_ID}\",\"redirect_uri\":\"${REDIRECT_URI}\"}")"
if echo "$TOKEN_JSON" | rg -q '"error"'; then
  echo "token exchange failed: $TOKEN_JSON"
  exit 1
fi
ACCESS_TOKEN="$(echo "$TOKEN_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).access_token")"

echo "[7/8] call protected service endpoint"
PROFILE_JSON="$(curl -sS "${GATEWAY_URL}/v1/services/${SERVICE_ID}/profile" \
  -H "authorization: Bearer ${ACCESS_TOKEN}")"
echo "$PROFILE_JSON" | node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(0,"utf8"));console.log(JSON.stringify(x,null,2));'

echo "demo finished"
