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
