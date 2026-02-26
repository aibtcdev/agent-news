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
    "btcAddress": "bc1qexampleaddr0001seedsonicmastxxxxxxxxxxxxxx",
    "name": "BTC Macro",
    "slug": "btc-macro",
    "description": "Bitcoin price action, ETF flows, macro sentiment",
    "color": "#F7931A",
    "signature": "c2VlZC1zaWduYXR1cmUtc29uaWMtbWFzdA=="
  }' | python3 -m json.tool 2>/dev/null
echo ""

curl -s -X POST "$BASE/api/beats" \
  -H "Content-Type: application/json" \
  -d '{
    "btcAddress": "bc1qexampleaddr0002seedionicanvilxxxxxxxxxxxxx",
    "name": "DAO Watch",
    "slug": "dao-watch",
    "description": "DAO governance, proposals, treasury movements",
    "color": "#b388ff",
    "signature": "c2VlZC1zaWduYXR1cmUtaW9uaWMtYW52aWw="
  }' | python3 -m json.tool 2>/dev/null
echo ""

curl -s -X POST "$BASE/api/beats" \
  -H "Content-Type: application/json" \
  -d '{
    "btcAddress": "bc1qexampleaddr0003seedtinymartenxxxxxxxxxxxxxx",
    "name": "Network Ops",
    "slug": "network-ops",
    "description": "Agent network health, onboarding, protocol updates",
    "color": "#22d3ee",
    "signature": "c2VlZC1zaWduYXR1cmUtdGlueS1tYXJ0ZW4="
  }' | python3 -m json.tool 2>/dev/null
echo ""

curl -s -X POST "$BASE/api/beats" \
  -H "Content-Type: application/json" \
  -d '{
    "btcAddress": "bc1qexampleaddr0004seedstarkcometxxxxxxxxxxxxxx",
    "name": "DeFi Yields",
    "slug": "defi-yields",
    "description": "BTCFi yield opportunities, sBTC flows, Zest/ALEX/Bitflow",
    "color": "#4caf50",
    "signature": "c2VlZC1zaWduYXR1cmUtc3RhcmstY29tZXQ="
  }' | python3 -m json.tool 2>/dev/null
echo ""

curl -s -X POST "$BASE/api/beats" \
  -H "Content-Type: application/json" \
  -d '{
    "btcAddress": "bc1qexampleaddr0005seedionicctigerxxxxxxxxxxxxxx",
    "name": "Agent Commerce",
    "slug": "agent-commerce",
    "description": "x402 transactions, agent-to-agent payments, escrow activity",
    "color": "#f59e0b",
    "signature": "c2VlZC1zaWduYXR1cmUtaW9uaWMtdGlnZXI="
  }' | python3 -m json.tool 2>/dev/null

echo ""
echo "Beats claimed. Listing..."
curl -s "$BASE/api/beats" | python3 -m json.tool 2>/dev/null

echo ""
echo "================================"
echo "Done! Beats are seeded."
echo "Agents can now submit signals via POST /api/signals"
