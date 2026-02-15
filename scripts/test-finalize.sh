#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

GATEWAY_URL="${GATEWAY_URL:-http://localhost:14000}"
CLIENT_SECRET="${CLIENT_SECRET:-dev-service-secret}"

if [ ! -f "data/wallet.json" ]; then
  echo "error: data/wallet.json not found."
  exit 1
fi

DID="$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('data/wallet.json','utf8'));if(!j.wallets||!j.wallets[0]) process.exit(1);console.log(j.wallets[0].did)")"
if [ -z "$DID" ]; then
  echo "error: DID not found."
  exit 1
fi

ENC_DID="$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$DID")"
APPROVED_JSON="$(curl -sS "${GATEWAY_URL}/v1/wallet/approved?did=${ENC_DID}")"
COUNT="$(echo "$APPROVED_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).approved.length")"
if [ "$COUNT" -eq 0 ]; then
  echo "no approved items to finalize."
  exit 0
fi

AUTH_CODE="$(echo "$APPROVED_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).approved[0].authorization_code")"
CLIENT_ID="$(echo "$APPROVED_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).approved[0].client_id")"
REDIRECT_URI="$(echo "$APPROVED_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).approved[0].redirect_uri")"
SERVICE_ID="$(echo "$APPROVED_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).approved[0].service_id")"

echo "finalizing service=${SERVICE_ID} auth_code=${AUTH_CODE}"
TOKEN_JSON="$(curl -sS -X POST "${GATEWAY_URL}/v1/token/exchange" \
  -H 'content-type: application/json' \
  -H "x-client-id: ${CLIENT_ID}" \
  -H "x-client-secret: ${CLIENT_SECRET}" \
  -d "{\"grant_type\":\"authorization_code\",\"code\":\"${AUTH_CODE}\",\"client_id\":\"${CLIENT_ID}\",\"redirect_uri\":\"${REDIRECT_URI}\"}")"
ACCESS_TOKEN="$(echo "$TOKEN_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).access_token")"

PROFILE_JSON="$(curl -sS "${GATEWAY_URL}/v1/services/${SERVICE_ID}/profile" \
  -H "authorization: Bearer ${ACCESS_TOKEN}")"
echo "$PROFILE_JSON" | node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));console.log(JSON.stringify(j,null,2));'
echo "finalize passed"
