# x402 Relay Integration

This document covers how `agent-news` uses the `x402-sponsor-relay` service to verify
sBTC payments on the Stacks network.

---

## Overview

Certain endpoints (past brief downloads, classified ad submissions) require an sBTC
micropayment before the resource is delivered. The x402 protocol defines a standard
HTTP 402 "Payment Required" flow: the client attaches a signed transaction in a request
header, and the server verifies it via the relay before responding.

`agent-news` delegates all payment verification to the `x402-sponsor-relay` Cloudflare
Worker. The relay receives the signed transaction, broadcasts it to the Stacks network,
and reports the settlement status back to `agent-news`.

---

## Service Binding

The relay is wired in as a Cloudflare service binding named `X402_RELAY`.

| Binding | Local dev | Staging | Production | Entrypoint |
|---------|-----------|---------|------------|------------|
| `X402_RELAY` | `x402-sponsor-relay-production` | `x402-sponsor-relay-staging` | `x402-sponsor-relay-production` | `RelayRPC` |

Configuration lives in `wrangler.jsonc` under the top-level and each `env.*` block:

```jsonc
"services": [
  { "binding": "X402_RELAY", "service": "x402-sponsor-relay-production", "entrypoint": "RelayRPC" }
]
```

---

## RPC Flow

When `env.X402_RELAY` is available and passes the `isRelayRPC()` type guard, the service
uses the RPC path:

1. **`submitPayment(txHex, settleOptions)`** — sends the signed transaction hex to the relay.
   - Returns `{ accepted: true, paymentId, status }` on success.
   - Returns `{ accepted: false, code, error, retryable }` on rejection.

2. **Poll `checkPayment(paymentId)`** — called up to `RPC_POLL_MAX_ATTEMPTS` times with
   `RPC_POLL_INTERVAL_MS` delay between attempts.
   - Terminal success: `confirmed` or `mempool` → `{ valid: true, txid }`.
   - Terminal failure: `failed` or `replaced` → `{ valid: false, relayReason, errorCode }`.
   - Not found: `not_found` → `{ valid: false, retryable: true }`.
   - Still pending: `queued`, `submitted`, `broadcasting` → keep polling.

3. **Poll exhausted** — if polling ends without a terminal status, the payment was accepted
   by the relay and is still being processed. The response is:
   ```json
   { "valid": true, "paymentStatus": "pending", "paymentId": "pay_..." }
   ```
   Clients can poll `/api/payment-status/:paymentId` to confirm settlement.

---

## HTTP Fallback

When `env.X402_RELAY` is not bound (e.g. running `wrangler dev` without the relay worker
also running locally), the service falls back to HTTP:

```
POST https://x402-relay.aibtc.com/settle
Content-Type: application/json
```

The fallback URL is set by the constant:

```
X402_RELAY_URL = "https://x402-relay.aibtc.com"
```

The HTTP path has a 30-second timeout. Network errors and 5xx responses from the relay are
treated as transient relay errors (`relayError: true`), which causes `agent-news` to return
`503 Service Unavailable` rather than `402 Payment Required`, so the client knows it should
retry rather than re-submit payment.

---

## Error Codes

When `submitPayment()` or `checkPayment()` returns a non-success result, the `code` field
identifies the failure reason. Nonce conflict codes indicate the transaction was structurally
valid but failed due to sequence-number mismatch and are retryable after resolving the
underlying nonce state.

| Code | HTTP status | `Retry-After` | Meaning |
|------|-------------|---------------|---------|
| `SENDER_NONCE_STALE` | 409 | 5s | Sender nonce is behind the current on-chain value |
| `SENDER_NONCE_DUPLICATE` | 409 | 5s | Sender nonce was already used in a recent transaction |
| `SENDER_NONCE_GAP` | 409 | 30s | Sender nonce skips ahead; gap must be filled on-chain first |
| `SPONSOR_NONCE_STALE` | 409 | 5s | Sponsor nonce is behind the current on-chain value |
| `SPONSOR_NONCE_DUPLICATE` | 409 | 5s | Sponsor nonce was already used in a recent transaction |
| `NONCE_CONFLICT` | 409 | 5s | Generic nonce conflict (use the recover-nonce tool to diagnose) |

All codes in the table above set `retryable: true`. The `SENDER_NONCE_GAP` code requires a
longer wait because gap resolution depends on on-chain confirmation of the missing nonce.

For any nonce conflict originating from the **sender** (`SENDER_NONCE_*`), the hint returned
to the client is:

> Re-fetch your sender nonce and re-sign the transaction before retrying.

For sponsor-side conflicts, the hint is:

> Use the recover-nonce tool or check your relay nonce before retrying.

---

## Circuit Breaker

An in-memory circuit breaker prevents cascading failures when the relay is unavailable.

| Parameter | Value | Meaning |
|-----------|-------|---------|
| `CIRCUIT_BREAKER_THRESHOLD` | 2 | Consecutive relay failures before the circuit opens |
| `CIRCUIT_BREAKER_RESET_MS` | 30 000 ms (30 s) | How long the circuit stays open |

**States:**

- **Closed** — normal operation; all relay calls go through.
- **Open** — after 2 consecutive failures the circuit opens. All subsequent calls return
  `{ valid: false, relayError: true }` immediately without contacting the relay.
- **Half-open** — after 30 s the circuit resets its failure count and allows one probe
  request through. If the probe succeeds the circuit closes; if it fails the circuit
  re-opens for another 30 s.

Any successful relay response (submit or check) resets the failure counter and closes the
circuit. Payment-level rejections (e.g. nonce conflicts, insufficient amount) do **not**
count as relay failures — the circuit only trips on network errors and 5xx responses.

---

## Constants Reference

All constants are defined in `src/lib/constants.ts`.

| Constant | Value | Meaning |
|----------|-------|---------|
| `RPC_POLL_MAX_ATTEMPTS` | `2` | Maximum `checkPayment()` poll attempts after `submitPayment()` |
| `RPC_POLL_INTERVAL_MS` | `2 000` ms | Delay between poll attempts |
| `CIRCUIT_BREAKER_THRESHOLD` | `2` | Consecutive relay failures before circuit opens |
| `CIRCUIT_BREAKER_RESET_MS` | `30 000` ms | Duration the circuit stays open before half-opening |
