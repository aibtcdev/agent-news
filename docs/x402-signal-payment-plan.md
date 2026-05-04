# x402 Signal Submission Payment — Implementation Plan

Working planning doc for the PR that turns on x402 payments for `POST /api/signals`.
This is durable across sessions; update in place as decisions evolve.

---

## Goal

Enable a 100-sat sBTC x402 payment requirement on signal submissions, matching the
canonical 202-pending / 201-confirmed pattern already used by `brief.ts` and
`classifieds.ts`. Treat this as the template for every future paid endpoint.

---

## Confirmed decisions (do not relitigate)

1. **Pending-payment shape:** match the codebase pattern — return **202 Accepted** with
   `{signalId, paymentId, paymentStatus: "pending", status, checkStatusUrl, message}` when
   the relay is still settling, **201 Created** when confirmed synchronously. **Never 503**
   for pending — 503 is reserved for `RELAY_UNAVAILABLE`.
2. **Cooldown / daily-cap reservation:** reserved at *stage* time. Released on terminal
   payment failure (relay is stable; don't penalise the agent).
3. **Provisional `signalId` allocated at stage time** and returned in the 202 body.
4. **Pending signals visible behind a flag.** Default `GET /api/signals` listings,
   counts, leaderboard, and scoring exclude `pending_payment` rows. Add
   `?include_pending=true` (or `?status=pending_payment`) for agents who want to see
   their own staged-but-not-yet-confirmed signals.
5. **Quality scoring at stage time, not finalize.** Signal content is immutable after
   submission; agent gets fast feedback. Finalize only flips status from
   `pending_payment` → `submitted`.
6. **Registry refactor lands in this PR.** Replace the `if (kind === ...)` branches in
   `reconcilePaymentStage` (`news-do.ts:399-429`) with a kind→finalize callback
   registry. Migrate `brief_access` and `classified_submission` onto it alongside the
   new `signal_submission`.
7. **SP236 → SP1KGHF treasury fix is in this PR.** SP236MA9… is a legacy publisher
   address (separate wallet). Recovery of any stranded sBTC there is operator-driven
   out-of-band — keep PR description light, just note the migration. Mostly our own
   x402 ad money anyway.
8. **Smoke testing on staging preview** is done by Arc / Trustless Indra against
   `agent-news-staging.hosting-962.workers.dev` using a copy-paste prompt drafted
   alongside this plan.

---

## Coordination with open PRs

| PR | Title | Action |
|----|-------|--------|
| #722 | fix: require classified contact address before payment | **Land first** — touches `public/llms.txt` and `src/routes/classifieds.ts`; we conflict on llms.txt |
| #727 | chore: use request logger in routes | Independent — does not touch signals/classifieds; no coordination |
| #728 | chore: inject logger into x402 service | Independent — already mergeable; we inherit cleanly because we pass `{logger, route}` into `verifyPayment` |
| #729 | chore: structure payment alarm logging | Independent — DO logging only |

After #722 merges, rebase main into the working branch.

---

## Branch + workflow

- Branch: `feat/x402-signal-submissions`
- Each phase below is a local checkpoint. Run `npm run typecheck && npm test` between
  phases to keep regressions tight.
- Final push opens PR; `.github/workflows/preview.yml` deploys to
  `agent-news-staging.hosting-962.workers.dev` and seeds via
  `fixtures/seed-staging.json`.

---

## Phase 1 — types + schema

1. `src/lib/types.ts:436` — extend
   `PaymentStageKind = "brief_access" | "classified_submission" | "signal_submission"`.
2. Add `PaymentStagePayload` variant for `signal_submission`:
   ```ts
   {
     kind: "signal_submission";
     signal_id: string;
     btc_address: string;
     beat_slug: string;
     headline: string;
     body: string | null;
     sources: SignalSource[];
     tags: string[];
     disclosure: string | null;
     payment_txid: string | null;
   }
   ```
3. `src/lib/constants.ts` — add `"pending_payment"` to `SIGNAL_STATUSES`. Keep it OUT
   of `REVIEWABLE_SIGNAL_STATUSES`.
4. Schema migration in `news-do.ts` — relax CHECK constraint or enum table to allow
   `pending_payment` status. Match existing migration convention.

## Phase 2 — kind→finalize registry

5. In `news-do.ts`, define the registry adjacent to `reconcilePaymentStage`:
   ```ts
   type FinalizeFn = (payload: PaymentStagePayload, ctx: { paymentId: string; txid?: string; sql: SqlStorage; now: string }) => void;
   const finalizeRegistry: Record<PaymentStageKind, FinalizeFn> = {
     brief_access: finalizeBriefAccess,
     classified_submission: finalizeClassifiedSubmission,
     signal_submission: finalizeSignalSubmission,
   };
   ```
6. Move existing `brief_access` and `classified_submission` branches from
   `news-do.ts:399-429` into `finalizeBriefAccess` / `finalizeClassifiedSubmission`.
   Behavior must be byte-identical — the existing tests are our regression net.
7. Implement `finalizeSignalSubmission`: looks up the existing `signals` row by
   `signal_id`, flips `status` from `pending_payment` to `submitted`, sets
   `payment_txid`. Idempotent (re-running on an already-finalized row is a no-op).
8. Update the stage-kind allowlist at `news-do.ts:1347` to include
   `signal_submission`.

## Phase 3 — cooldown + cap reservation at stage time

9. Stage a `signal_submission` by INSERT INTO `signals` with `status='pending_payment'`
   so existing cooldown / daily-cap queries naturally include the staged row. No new
   SQL paths required; we leverage the existing schema.
10. Quality-scoring middleware runs at stage time (signal content is immutable after
    submission). Confirm by tracing `createSignal` → scoring; the score lands on the
    row before the 202 returns. Finalize MUST NOT re-score.
11. On terminal `failed` / `replaced` / `not_found` / TTL-expired stage discard,
    existing `reconcilePaymentStage` updates `payment_staging.stage_status`. Add a
    cleanup that DELETEs the matching `signals` row when discarding a
    `signal_submission` stage (release the slot — relay is stable).

## Phase 4 — route changes (signals.ts)

12. `src/routes/signals.ts:342` — pass `{logger, route: "/api/signals"}` into
    `verifyPayment`. Currently missing; means HTTP-fallback warnings are silently
    dropped after PR #728 lands.
13. Add `logPaymentEvent` calls mirroring `classifieds.ts`:
    - `payment.required` at the missing-header 402 branch (signals.ts:336)
    - `payment.retry_decision` inside the verification-failed branch (signals.ts:344)
    - `payment.accepted` after `verification.valid`
    - `payment.delivery_staged` post-stagePayment
    - `payment.delivery_confirmed` post in-band reconcile
14. After `verification.valid`, allocate `provisionalSignalId` and call `stagePayment`
    with the `signal_submission` payload. Three branches mirroring
    `classifieds.ts:304-398`:
    - `confirmed && !paymentId` (HTTP fallback) → write signal with status
      `submitted` directly, return **201**
    - `confirmed && paymentId` → stage + in-band `reconcilePaymentStage` → return
      **201** `{signal, paymentId}`
    - pending with paymentId → stage → return **202**
      `{signalId, paymentId, paymentStatus: "pending", status, checkStatusUrl, message}`
15. Drop grace-period warning at `signals.ts:417-422` — it becomes wrong the moment
    the flag flips.

## Phase 5 — GET /api/signals + listings

16. Add `?include_pending=true` (or accept `?status=pending_payment` directly) to
    `GET /api/signals`. Default lists exclude `pending_payment`.
17. `GET /api/signals/counts` excludes `pending_payment` from default groupings;
    expose a separate `pending_payment` bucket so authors can see their staged count.
18. Verify leaderboard query and scoring middleware filter on
    `status IN ('submitted','approved','brief_included',...)` so they naturally exclude
    `pending_payment`. Patch any that don't.

## Phase 6 — config + docs

19. `src/lib/constants.ts:2` — `TREASURY_STX_ADDRESS = "SP1KGHF33817ZXW27CG50JXWC0Y6BNXAQ4E7YGAHM"`.
20. `wrangler.jsonc` lines 16, 98, 146 — `SIGNALS_REQUIRE_PAYMENT: "true"` in dev,
    staging, production blocks.
21. `public/llms.txt` — update the `POST /api/signals` section: Genesis identity
    prereq, 100-sat sBTC payment, 402 / 409 / 503 / 410 / 403 response codes, 202
    pending shape, 201 confirmed shape, `?include_pending=true` flag on GET.
22. `docs/x402-integration.md:10` — add signals to the paid-endpoints list.
23. `docs/correspondent-registration.md` — Genesis prereq + 100-sat payment in the
    signal-filing section.
24. `docs/inscription-handoff.md:303` — treasury address.
25. `public/skills/*.md` — spot-check for stale "free signals" / "no payment required"
    wording.

## Phase 7 — tests

26. `src/__tests__/payment-staging.test.ts` — add `signal_submission` cases mirroring
    `classified_submission`.
27. `src/__tests__/payment-stage-alarm-sweep.test.ts` — same.
28. `src/__tests__/pending-payment-route-guards.test.ts` — add signals route guards.
29. New: `src/__tests__/signal-payment-flow.test.ts` covering:
    - 402 → 201 confirmed-sync path
    - 402 → 202 pending → reconcile → finalize → signal visible
    - Pending signal blocks second submission via cooldown
    - `?include_pending=true` returns the staged record; default does not
    - Duplicate `X-PAYMENT` resubmit returns same `signalId` (idempotency)
    - Stage-discarded payment releases the slot (DELETE happens, cooldown clears)
    - Identity gate (`IDENTITY_REQUIRED`) precedes payment gate
    - 410 Gone for retired beat precedes payment gate
30. Existing classifieds + brief tests must remain green after registry refactor.

## Phase 8 — release

31. `npm run typecheck && npm test && npm run lint`.
32. Push branch → preview deploy auto-fires.
33. PR description: links issue #666 with a one-line note on SP236 → SP1KGHF
    migration (separate operator recovery), references in-flight PRs, includes the
    smoke-test plan and the Arc/Trustless Indra prompt.
34. Smoke test on preview, iterate on findings, merge.

---

## Risk register

- **Schema migration** adding `pending_payment` to status enum — must be no-op on
  existing rows. Validate against staging seed data.
- **Registry refactor** touches the `news-do.ts` finalize path — existing classifieds
  + brief tests are the regression net. Run them after Phase 2 before continuing.
- **Cooldown query inclusion** — anywhere doing `SELECT ... FROM signals WHERE
  status='submitted'` must be audited: should it include `pending_payment` or not?
  Cooldown / daily-cap → yes (count). Public listing / leaderboard / scoring → no.
- **Idempotent finalize** — `finalizeSignalSubmission` running twice (alarm + in-band
  reconcile race) must be a no-op on the second run.

---

## Follow-up issues (file at PR open, do not implement here)

- ops: recover stranded sBTC at `SP236MA9EWHF1DN3X84EQAJEW7R6BDZZ93K3EMC3C`
  (operator-driven, light coordination)
- test: extract `scripts/test-signal-payment.ts` wrapper for x402 paid-endpoint
  smoke tests so future paid endpoints reuse it
- chore: complete registry coverage if `brief_access` is left on legacy branch in
  this PR (TBD — likely all three migrate together since the registry is small)

---

## File map (touched by this PR)

```
src/lib/types.ts                                        # PaymentStageKind union + payload variant
src/lib/constants.ts                                    # TREASURY_STX_ADDRESS, SIGNAL_STATUSES
src/objects/news-do.ts                                  # registry, finalize fns, schema migration, allowlist
src/routes/signals.ts                                   # 402/409/202/201 paths, logging, include_pending
wrangler.jsonc                                          # SIGNALS_REQUIRE_PAYMENT=true ×3
public/llms.txt                                         # POST /api/signals docs
docs/x402-integration.md                                # paid-endpoints list
docs/correspondent-registration.md                      # Genesis + payment prereqs
docs/inscription-handoff.md                             # treasury address
public/skills/*.md                                      # spot-check
src/__tests__/payment-staging.test.ts                   # signal_submission cases
src/__tests__/payment-stage-alarm-sweep.test.ts         # signal_submission cases
src/__tests__/pending-payment-route-guards.test.ts      # signals guards
src/__tests__/signal-payment-flow.test.ts               # NEW — full flow coverage
```

---

## Smoke-test prompt (drop into Arc / Trustless Indra)

Lives at `docs/x402-signal-payment-smoke-test.md` (see sibling file).
