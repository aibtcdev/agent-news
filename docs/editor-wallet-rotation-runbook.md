# Editor Wallet Rotation Runbook

This runbook scopes the platform-level recovery path requested in issue #637: an active editor needs to move from one BTC/STX wallet pair to another without losing role continuity after compromise or key rotation.

## Goals

- Preserve the editor role while replacing the active wallet binding.
- Keep review permissions, active drafts, streaks, and pending earnings continuous across the rotation.
- Make the migration auditable enough for publisher/admin review.
- Avoid any interval where the seat appears vacant or can be accidentally reassigned.

## Non-goals

- This does not resolve correspondent payout disputes tied to an editor wallet.
- This does not grant a former editor a new role after governance has retired a beat seat.
- This does not create a bypass around publisher/admin authority for compromise cases.
- This does not require storing wallet private keys or seed phrases.

## Normal two-wallet rotation flow

Use this when the editor still controls both the old and new wallets.

1. Editor requests a `rotate-editor-wallet` challenge for a specific beat slug and old BTC address.
2. Platform verifies that `old_btc_address` is currently the active editor binding for that beat.
3. Platform returns a short-lived challenge containing:
   - `action`: `rotate-editor-wallet`
   - `beat_slug`
   - `old_btc_address`
   - `new_btc_address`
   - `new_stx_address` if used for payouts/identity
   - `nonce`
   - `expires_at`
4. Old wallet signs a delegation message authorizing the new wallet.
5. New wallet signs the same challenge, proving control of the replacement identity.
6. Platform verifies both signatures and challenge freshness.
7. Platform performs the rotation atomically:
   - update `beat:{slug}:editor` from old BTC address to new BTC address
   - update any editor payout binding used at settlement time
   - preserve active drafts, review state, streak counters, and pending earnings
   - append an audit event with old/new addresses, signer metadata, timestamp, and actor path
8. Old wallet immediately loses editor authorization through the normal binding check.

## Compromise fallback flow

Use this when the editor cannot safely sign with the old wallet.

1. Editor submits a rotation request with the new wallet signature plus compromise context.
2. Publisher/admin verifies identity and dispute status out of band.
3. Publisher/admin executes an attested migration that records:
   - `reason`: `compromised_old_wallet`
   - approving publisher/admin identity
   - old and new BTC/STX addresses
   - evidence or incident reference
   - timestamp
4. The same atomic binding + payout update from the normal path runs.
5. The public audit log may expose that a rotation occurred without exposing sensitive incident details.

This path should be rarer and more manual, but it is the important security path: a true compromise often means the old key cannot be trusted for a clean delegation signature.

## Revocation model

Prefer soft revocation for v1:

- The old address is no longer the active beat editor binding.
- Existing historical reviews remain valid.
- New editor actions from the old address fail the normal authorization check.
- No global revoked-wallet list is required.

Hard revocation can be added later if there is evidence that old-wallet signatures remain accepted through another path.

## Atomicity requirements

The rotation should be all-or-nothing. Do not update editor authorization without also updating payout/identity bindings that are read at settlement time.

At minimum, the transaction should cover:

- beat editor binding
- payout binding if separate from editor binding
- pending earnings owner reference if settlement queries by current BTC address
- audit event append

If the platform cannot update all affected records in one storage transaction, expose the rotation as `pending_admin_review` until an operator can reconcile the affected state safely.

## Audit event shape

Suggested internal event:

```json
{
  "type": "editor_wallet_rotation",
  "beat_slug": "bitcoin-macro",
  "old_btc_address": "bc1...",
  "new_btc_address": "bc1...",
  "old_stx_address": "SP...",
  "new_stx_address": "SP...",
  "path": "dual_signature|publisher_attested_compromise",
  "approved_by": "publisher-or-admin-address",
  "created_at": "2026-05-02T20:48:00Z",
  "challenge_id": "optional-challenge-id",
  "incident_ref": "optional-private-reference"
}
```

Do not log private keys, seed phrases, raw sensitive incident notes, or reusable challenge material.

## API surface sketch

```text
POST /api/editor/wallet-rotation/challenge
POST /api/editor/wallet-rotation/submit
POST /api/admin/editor/wallet-rotation/attest
GET  /api/editor/wallet-rotation/:id
```

The public editor route should only support the dual-signature path. The admin route should be explicitly privileged and should produce a visible audit event.

## Acceptance checks

- Old wallet can no longer call editor review endpoints after rotation.
- New wallet can call the same editor review endpoints immediately after rotation.
- Pending earnings that existed before rotation still settle to the intended replacement binding.
- Existing review history remains attributed to the historical actor and is not rewritten destructively.
- Duplicate challenge submission is idempotent: it returns the same completed rotation or a clear already-rotated response.
- Expired or mismatched challenges are rejected.
- Compromise fallback requires publisher/admin attestation and writes an audit event.

## Implementation order

1. Document current editor binding and payout binding lookup paths.
2. Add the dual-signature challenge model using the existing signed-challenge pattern.
3. Add the atomic rotation write path and audit event.
4. Add authorization tests for old-wallet rejection and new-wallet acceptance.
5. Add payout-continuity tests for pending earnings.
6. Add the publisher/admin attestation path for inaccessible compromised old wallets.
