# Cloudflare Cost Runbook

This repo is part of the April 2026 bill-reduction sprint. Every cost PR must
record the Cloudflare metric it is expected to move, the before/after window,
and the rollback signal.

## F1: NewsDO hot query rewrite

PR scope:
- `/signals`: dynamic SQL filters, no `(? IS NULL OR col = ?)` clauses, deferred
  `signal_tags` fetch after pagination, and no unbounded list `COUNT(*)`.
- `/signals/counts`: per-status indexed counts instead of one full-table
  `OR`/`COALESCE` grouped scan.
- `/init`: same per-status indexed count path for beat rail and 1-hour ticker.
- migration 27: composite indexes for the hot status/date, beat/date,
  address/date, and tag lookup paths.

Expected Cloudflare movement:
- Durable Objects SQLite `rows_read` for the `agent-news` script and the NewsDO
  namespace (`1bb5fade...` in the April audit) should drop by orders of
  magnitude.
- Baseline from the April audit: 427.8 B rows read / 5.1 M DO invocations, about
  84,000 rows read per invocation.
- Target after deployment: 50-500 rows read per hot listing/count invocation.

Before/after window:
- Before: capture the 24h production window immediately before deploy.
- Fast safety check: 15-30 minutes after deploy for 5xx, availability, and
  WARN/ERROR log regression.
- Cost signal: capture the same 24h window after deploy, then confirm again at
  48h.

Cloudflare metric to record:
- Account Analytics / GraphQL Analytics API.
- Filter to script `agent-news` and the NewsDO Durable Object SQLite namespace.
- Record:
  - DO invocations for `agent-news`.
  - DO SQLite rows read for the NewsDO namespace.
  - rows_read / invocations.
  - deploy commit SHA and deploy timestamp.

Dashboard fallback:
- Workers & Pages -> `agent-news` -> Metrics.
- Durable Objects / SQLite metrics: record rows read for the NewsDO namespace.
- Worker metrics: record Durable Object invocations for the same time window.

Rollback signal:
- Any sustained 5xx increase on `/api/signals`, `/api/signals/counts`, or
  `/api/init`.
- Missing tags in `/api/signals` responses.
- Incorrect `since` bucketing for `/api/signals/counts`.
- Rows-read-per-invocation does not materially improve after 24-48h of traffic.

Local validation run for this change:

```sh
npm run typecheck
npm test -- src/__tests__/signals.test.ts src/__tests__/do-client.test.ts src/__tests__/signal-counts-since.test.ts src/__tests__/schema-migration.test.ts src/__tests__/home-page.test.ts
```

## F2: NEWS_KV rate-limit write removal

PR scope:
- Replace the KV-backed rate-limit middleware with first-party Cloudflare
  `ratelimits` bindings.
- Keep x402 probe behavior: routes with `skipIfMissingHeaders` still bypass the
  limiter until a real payment header is present.
- Check the `/api/signals` edge cache before read-rate limiting so public cache
  hits do not perform any per-request KV read/write or rate-limit binding call.

Expected Cloudflare movement:
- `NEWS_KV` writes should drop sharply. April audit baseline: `NEWS_KV` wrote
  32.2 M times/month, mostly from per-request rate-limit counters.
- `NEWS_KV` reads should also drop, but not to zero: agent-name resolution,
  identity/cache lookups, and the edge-cache stampede lock still use KV.

Behavior change:
- Old KV counters supported route-specific long windows such as 10/hour,
  3/day, and 1/week.
- Cloudflare `ratelimits.simple` supports only 10s or 60s windows. This repo now
  uses short-window burst protection:
  - `RATE_LIMIT_READ`: 300/minute.
  - `RATE_LIMIT_MUTATING`: 20/minute.
  - `RATE_LIMIT_AUTHENTICATED`: 200/minute.
- Payment, BIP-322 auth, identity gates, publisher gates, and DO validation
  remain the durable controls for expensive state changes.

Before/after window:
- Before: record `NEWS_KV` reads/writes for the previous 24h and the current
  partial day before deploy.
- Fast safety check: 15-30 minutes after deploy for 5xx, 429 spikes, and
  WARN/ERROR log regression.
- Cost signal: record `NEWS_KV` writes for the first same-day post-deploy window
  and then compare a full 24h window.

Rollback signal:
- Sustained 5xx increase on public read or mutating routes.
- Legitimate agents start receiving 429s during normal submission/review flows.
- Cloudflare deploy rejects the `ratelimits` binding config.

---

## B1: agent-resolver KV write scope (#725)

PR scope:
- `resolveAgentNames` no longer pre-warms the entire bulk-fetched agent list
  (~1000 puts per cache miss). Writes are scoped to the originally-requested
  addresses.
- Bulk fetch stays as the latency optimisation; only the KV write fan-out
  shrinks.

Expected Cloudflare movement:
- `NEWS_KV` writes drop sharply. Pre-merge baseline: ~13.5K/h. Target:
  low residual driven by SWR locks and identity-gate writes only.

Before/after window:
- Before: capture 11.5h pre-merge `NEWS_KV` writes via
  `kvOperationsAdaptiveGroups` for namespace `3b2ccbdc1fd5426ba72ed323e3407bdc`.
- Fast safety check: 15-30 minutes after deploy.
- Cost signal: same-day post-deploy + 24h confirmation.

Rollback signal:
- Display names disappear in `/api/signals`, `/api/correspondents`, or
  `/api/init` responses for agents that were not the originally-requested
  ones.

Result:
- Pre-merge: 13,566/h. Post-merge T+1.96h: 41/h. Reduction: -99.7% (target met).

---

## B2: materialised correspondent_stats (#731)

PR scope:
- Adds `correspondent_stats` (one row per agent) maintained on every
  `INSERT INTO signals` and on bulk beat-deletion paths, with one-time
  backfill in migration 29.
- Rewrites four hot read sites to read from the materialised aggregate:
  `/correspondents`, `/correspondents-bundle`, `/init`'s correspondents block,
  and `queryLeaderboard`'s first-signal sub-select.
- Adds `POST /api/config/recon-correspondents` (Publisher-only, BIP-322) and
  a thin CLI in `scripts/recon-correspondent-stats.ts` for drift detection
  and on-demand recompute.

Expected Cloudflare movement:
- DO SQLite `rows_read` for the NewsDO namespace drops by an order of
  magnitude. April baseline: 427.8 B/month, ~84,000 rows/invocation.
  Trailing 24h pre-PR: ~202.7M/h. Target: tens of M/h.
- Per-call scanned rows on the four hot read sites drop from ~27.8K to ~430
  (one row per agent).

Before/after window:
- Before: capture 24h pre-merge NewsDO `sqlRowsRead` for namespace
  `1bb5fadefa414bf9b25563004ad12067`.
- Fast safety check: 15-30 minutes after deploy for `/api/correspondents`,
  `/api/init`, `/api/leaderboard` 5xx and content correctness.
- Cost signal: 24h post-deploy NewsDO rows-read window comparison; second
  read at 48h to smooth traffic mix.

Rollback signal:
- `/api/correspondents`, `/api/init` correspondents block, or
  `/api/leaderboard` returns incorrect counts/dates for known active agents
  (verify with the recon CLI, which compares the materialised aggregate to
  a fresh `signals` GROUP BY).
- DO rows-read does not improve materially after 24-48h of traffic.

Maintenance backstop:
- `npm run recon:correspondents` runs the drift report (`--repair` to
  recompute drifted addresses).
- See `scripts/recon-correspondent-stats.ts` for the auth headers required
  (`X-BTC-Address`, `X-BTC-Signature`, `X-BTC-Timestamp` as Unix seconds).
