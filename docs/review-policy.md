# Signal review policy notes

This document records the operational review contract that correspondents can rely on
when filing signals into the active newsroom.

## Post-consolidation approval capacity

The newsroom currently has 3 active beats, while the daily brief cap remains
`MAX_APPROVED_SIGNALS_PER_DAY = 30` across all beats.

That means the target steady-state capacity is roughly 10 approved signals per
active beat per UTC day when all active beats have enough high-quality supply.
This is a target, not an obligation to approve weak signals: editors should keep
quality standards intact and can approve fewer than 10 when supply is thin.

Per-beat `daily_approved_limit` values are optional overrides. When present, the
review path enforces the beat limit before approving another signal. When absent,
the global 30-signal cap is still the hard stop enforced before brief compilation.

## Displacement instead of first-arrival lock-in

When a beat or the global day is at capacity, later stronger signals should still
have a path into the roster. The review API supports this with
`displace_signal_id` on approval:

- the displaced signal must currently be `approved`
- the displaced signal must be in the same UTC day bucket as the incoming signal
- when a per-beat cap is the blocker, the displaced signal must be on the same
  beat
- `brief_included` signals are final for the compiled brief and are not valid
  displacement targets

This keeps crowded clusters from becoming purely first-arrival locked while
preserving an auditable replacement trail (`approved` -> `replaced`).

## Correspondent visibility

Correspondents should not have to wait until end-of-day to discover whether they
are filing into a saturated lane. The intended visibility surface is:

- per-beat counts from the signal count endpoints
- signal status transitions (`submitted`, `approved`, `rejected`, `replaced`,
  `brief_included`)
- queue metadata on public/status APIs when available, including queue position
  and estimated review time

Operationally, active UTC-day queues should be reviewed on a rolling/hourly
basis where possible. The goal is earlier signal fate visibility, not early final
brief locking.

## Cluster-cap guidance

Cluster caps are quality controls, not permanent locks. If a crowded cluster has
already reached its practical limit, editors should prefer one of these outcomes:

1. reject near-duplicate or weaker late signals with clear feedback
2. approve a materially stronger late signal by displacing the weaker approved
   same-day signal
3. keep both only when they add distinct decision-useful information and capacity
   remains available

Correspondents should check same-day approved signals before filing and look for
a genuinely different angle when a cluster is already saturated.
