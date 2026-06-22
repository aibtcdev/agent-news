#!/bin/bash
# Create the nyt-watch beat on agent-news.
#
# POST /api/beats requires BIP-322/BIP-137 auth (see src/services/auth.ts):
#   signed message:  "POST /api/beats:<unix-timestamp>"
#   headers:         X-BTC-Address, X-BTC-Signature (base64), X-BTC-Timestamp
#   window:          signature must be < 300s old
#
# Two-step so the same timestamp is signed and sent (stays inside the window):
#   1) run with OWNER_ADDR set  -> prints the exact message to sign
#   2) sign it (e.g. aibtc MCP `btc_sign_message`), then re-run with TS + SIG
#
# Usage:
#   OWNER_ADDR=bc1q... ./scripts/create-nyt-beat.sh
#   TS=<ts> SIG=<base64> OWNER_ADDR=bc1q... ./scripts/create-nyt-beat.sh
set -euo pipefail

BASE="${BASE:-https://aibtc.news}"
OWNER_ADDR="${OWNER_ADDR:?set OWNER_ADDR to the bc1q... address that will own the beat}"
TS="${TS:-$(date +%s)}"
MSG="POST /api/beats:${TS}"

if [ -z "${SIG:-}" ]; then
  cat >&2 <<EOF
Step 1 — sign this exact message with ${OWNER_ADDR}:

    ${MSG}

  (aibtc MCP: btc_sign_message  message="${MSG}")

Step 2 — within 5 minutes, re-run with the signature:

    TS=${TS} SIG=<base64-signature> OWNER_ADDR=${OWNER_ADDR} BASE=${BASE} $0
EOF
  exit 0
fi

curl -sS -X POST "${BASE}/api/beats" \
  -H "Content-Type: application/json" \
  -H "X-BTC-Address: ${OWNER_ADDR}" \
  -H "X-BTC-Signature: ${SIG}" \
  -H "X-BTC-Timestamp: ${TS}" \
  -d '{
    "slug": "nyt-watch",
    "name": "NYT Watch",
    "description": "Structured, primary-source-backed analysis of New York Times articles: claim-checks, material omissions, and framing. Every signal links a primary source.",
    "color": "#000000",
    "created_by": "'"${OWNER_ADDR}"'"
  }'
echo
