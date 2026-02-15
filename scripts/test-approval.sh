#!/usr/bin/env bash
set -euo pipefail

# Kept for backward compatibility.
# Approval must happen in menubar UI; this command only creates a request.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "test:approval now creates request only."
echo "approve in menubar, then run: npm run test:finalize"
bash scripts/test-auth-signup.sh
