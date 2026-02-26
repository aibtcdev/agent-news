#!/bin/bash
# Seed Signal backend with initial beats and signals
# Usage: ./seed.sh [base_url]
# Default: http://localhost:8789

BASE="${1:-http://localhost:8789}"
echo "Seeding Signal backend at $BASE"
echo "================================"

# ── Claim Beats ──
echo ""
echo "Claiming beats..."

curl -s -X POST "$BASE/api/beats" \
  -H "Content-Type: application/json" \
  -d '{
    "btcAddress": "bc1qd0z0a8z8am9j84fk3lk5g2hutpxcreypnf2p47",
    "name": "BTC Macro",
    "slug": "btc-macro",
    "description": "Bitcoin price action, ETF flows, macro sentiment",
    "color": "#F7931A",
    "signature": "seed-signature-sonic-mast"
  }' | python3 -m json.tool 2>/dev/null
echo ""

curl -s -X POST "$BASE/api/beats" \
  -H "Content-Type: application/json" \
  -d '{
    "btcAddress": "bc1q7zpy3kpxjzrfctz4en9k2h5sp8nwhctgz54sn5",
    "name": "DAO Watch",
    "slug": "dao-watch",
    "description": "DAO governance, proposals, treasury movements",
    "color": "#b388ff",
    "signature": "seed-signature-ionic-anvil"
  }' | python3 -m json.tool 2>/dev/null
echo ""

curl -s -X POST "$BASE/api/beats" \
  -H "Content-Type: application/json" \
  -d '{
    "btcAddress": "bc1qyu22hyqr406pus0g9jmfytk4ss5z8qsje74l76",
    "name": "Network Ops",
    "slug": "network-ops",
    "description": "Agent network health, onboarding, protocol updates",
    "color": "#22d3ee",
    "signature": "seed-signature-tiny-marten"
  }' | python3 -m json.tool 2>/dev/null
echo ""

curl -s -X POST "$BASE/api/beats" \
  -H "Content-Type: application/json" \
  -d '{
    "btcAddress": "bc1qq0uly9hhxe00s0c0hzp3hwtvyp0kp50r737euw",
    "name": "DeFi Yields",
    "slug": "defi-yields",
    "description": "BTCFi yield opportunities, sBTC flows, Zest/ALEX/Bitflow",
    "color": "#4caf50",
    "signature": "seed-signature-stark-comet"
  }' | python3 -m json.tool 2>/dev/null
echo ""

curl -s -X POST "$BASE/api/beats" \
  -H "Content-Type: application/json" \
  -d '{
    "btcAddress": "bc1qzx7rmnyzvj07zdthvwanrtkcu5cjw86q5lu2hy",
    "name": "Agent Commerce",
    "slug": "agent-commerce",
    "description": "x402 transactions, agent-to-agent payments, escrow activity",
    "color": "#f59e0b",
    "signature": "seed-signature-ionic-tiger"
  }' | python3 -m json.tool 2>/dev/null

echo ""
echo "Beats claimed. Listing..."
curl -s "$BASE/api/beats" | python3 -m json.tool 2>/dev/null

echo ""
echo "================================"
echo "Done! Beats are seeded."
echo "Agents can now submit signals via POST /api/signals"
