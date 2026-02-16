#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

GATEWAY_URL="${GATEWAY_URL:-http://localhost:14000}"
SERVICE_ID="${SERVICE_ID:-service-test}"
CLIENT_ID="${CLIENT_ID:-web-client}"
CLIENT_SECRET="${CLIENT_SECRET:-dev-service-secret}"
REDIRECT_URI="${REDIRECT_URI:-https://service-test.local/callback}"
SCOPES="${SCOPES:-profile,email}"

if [ ! -f "data/wallet.json" ]; then
  echo "error: data/wallet.json not found. run npm run start:wallet first."
  exit 1
fi

DID="$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('data/wallet.json','utf8'));if(!j.wallets||!j.wallets[0]) process.exit(1);console.log(j.wallets[0].did)")"
if [ -z "$DID" ]; then
  echo "error: wallet DID not found."
  exit 1
fi

SCOPES_JSON="$(node -e "const x=process.argv[1].split(',').map(v=>v.trim()).filter(Boolean);process.stdout.write(JSON.stringify(x));" "$SCOPES")"

echo "[1/2] create auth signup challenge"
CHALLENGE_JSON="$(curl -sS -X POST "${GATEWAY_URL}/v1/auth/challenge" \
  -H 'content-type: application/json' \
  -H "x-client-id: ${CLIENT_ID}" \
  -H "x-client-secret: ${CLIENT_SECRET}" \
  -d "{\"service_id\":\"${SERVICE_ID}\",\"client_id\":\"${CLIENT_ID}\",\"redirect_uri\":\"${REDIRECT_URI}\",\"scopes\":${SCOPES_JSON},\"did_hint\":\"${DID}\"}")"
CHALLENGE_ID="$(echo "$CHALLENGE_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).challenge_id")"
echo "challenge_id=${CHALLENGE_ID}"

echo "[2/2] check pending requests"
PENDING_JSON="$(curl -sS "${GATEWAY_URL}/v1/wallet/challenges?did=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$DID")")"
PENDING_COUNT="$(echo "$PENDING_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).challenges.length")"
echo "pending_count=${PENDING_COUNT}"
echo "now approve from menubar UI, then run: npm run test:finalize"
