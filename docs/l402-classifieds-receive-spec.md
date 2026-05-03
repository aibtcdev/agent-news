# L402 Classifieds Receive Spec

This document scopes the receive-side Lightning/L402 rail requested in issue #694 for `POST /api/classifieds`.

## Goal

Allow agents and wallets that already support Lightning/L402 to buy the same 3,000 sat classified placement without requiring sBTC or a Stacks x402 transaction.

The L402 path should be additive. The existing x402/sBTC rail remains supported.

## Non-goals

- Do not add L402 to every paid endpoint in the first pass.
- Do not bridge Lightning receipts into sBTC automatically.
- Do not infer a BTC contact address from a Lightning payer identity.
- Do not accept anonymous classifieds: the listing still needs a `bc1...` contact address.

## Proposed 402 response shape

When no payment header is present, `POST /api/classifieds` should advertise both rails:

```json
{
  "error": "Payment Required",
  "message": "Classified ad listing — place your ad for 3000 sats",
  "amount": 3000,
  "asset": "sats",
  "x402": {
    "x402Version": 2,
    "accepts": [
      {
        "scheme": "exact",
        "network": "stacks:1",
        "amount": "3000",
        "asset": "<sBTC contract>",
        "payTo": "<publisher STX treasury>",
        "maxTimeoutSeconds": 60,
        "description": "Classified ad listing"
      }
    ]
  },
  "l402": {
    "type": "l402",
    "amount": 3000,
    "asset": "sats",
    "invoice": "lnbc...",
    "macaroon": "<base64-macaroon>",
    "expiresAt": "<current_time + invoice_ttl_seconds>"
  }
}
```

Header compatibility:

- x402/sBTC submit: existing `X-PAYMENT` or `payment-signature` header.
- L402 submit: `Authorization: L402 <macaroon>:<preimage>` or the exact header form required by the selected L402 library/relay.

## Request body contract

The body should remain shared across rails:

```json
{
  "title": "Build your own AIBTC agent in an hour",
  "category": "services",
  "body": "Optional copy, max 500 chars",
  "btc_address": "bc1..."
}
```

`btc_address` (or `contact`) is required for L402 submissions because Lightning settlement does not provide a public BTC address. This matches the safer x402 behavior from PR #722: validate contact fields before charging.

## Receive flow

1. Parse and validate JSON body before payment verification.
2. Validate `title`/`headline`, `category`, and `btc_address`/`contact` before charging.
3. If no payment proof is present, return 402 with both x402 and L402 requirements.
4. If x402 proof is present, use the existing x402 verification and staged-delivery path.
5. If L402 proof is present, verify the macaroon/preimage against the issued invoice.
6. Consume the verified proof atomically: the macaroon/preimage pair is single-use and must be marked spent before or in the same transaction as delivery staging.
7. On confirmed L402 settlement, stage the classified through the same durable delivery path used by x402 with:
   - `btc_address`: validated body contact address
   - `payment_txid`: Lightning payment hash or invoice identifier
   - `payment_rail`: `l402` (new field if schema allows; otherwise encode in lifecycle metadata first)
8. Return the same 201/202 delivery shape used by x402 so callers do not need rail-specific handling after payment.

## Data model options

Preferred first pass:

- Add `payment_rail TEXT NOT NULL DEFAULT 'x402'` to classifieds or payment staging metadata.
- Use an explicit migration so existing rows are backfilled as `x402`; that default is accurate for historical rows because all pre-L402 classifieds were paid through the x402/sBTC or wallet-driven legacy path.
- Store the Lightning payment hash in `payment_txid` only if no dedicated `payment_id`/`payment_hash` field exists.
- Track spent L402 proofs by stable invoice/payment hash (or provider-issued payment id) with a uniqueness constraint so replayed macaroon/preimage pairs cannot create duplicate listings.

If avoiding schema changes for v1, keep the classified row unchanged and record rail details in payment lifecycle logs. This is lower risk but weakens later TAM reporting and should not be used for the T+30 rail-split rollup.

## Open engineering decisions

1. Which L402 provider/verification library should own invoice issuance and macaroon verification? The likely starting point is the Spark SDK/L402 integration already shipped in `aibtc-mcp-server` v1.49.0 via PR #474.
2. Should invoice issuance happen inline on the 402 response or through a separate internal service binding?
3. What is the invoice expiry window? Recommended: 5-10 minutes, shorter than staged classified expiry.
4. Should L402 settlement use the existing `/api/payment-status/:paymentId` polling surface or a sibling `/api/l402-status/:paymentId` route?
5. Does the publisher need a dedicated Lightning/Spark treasury secret before receive-side work can ship?

## Safety requirements

- Never create a classified before payment settlement or staged-payment acceptance.
- Never charge before validating required listing fields.
- Never treat a Lightning payer identity as a BTC contact address.
- Each macaroon/preimage proof must be single-use: validate it against the issuer, consume it, and reject duplicate submissions that reuse the same proof.
- L402 settlement and classified staging must be idempotent. If settlement succeeds but classified creation fails, retry by payment id/hash should finalize the original staged classified rather than charge again.
- Keep x402 and L402 responses machine-readable so agents can choose either rail without scraping prose.
- Redact macaroon/preimage material from logs.

## Suggested implementation phases

### Phase 1 — API contract only

- Return a documented placeholder `l402` requirement only when the L402 issuer binding/config exists.
- Keep x402-only behavior when L402 config is absent.
- Add tests for response shape and pre-payment validation ordering.

### Phase 2 — L402 verification

- Add invoice issuance + verification service.
- Accept L402 proof headers.
- Persist spent proof/payment identifiers with uniqueness protection.
- Reuse the existing classified creation/staging path after verification so late delivery retries are idempotent.

### Phase 3 — reporting

- Add rail-level metrics: x402 vs L402 classified count, conversion, settlement failures, and refund/reconciliation incidents.
- Use the metric for the T+30 TAM rollup promised in #694.
