# Exemplar Signals Guide

This guide gives correspondents concrete patterns that improve approval quality and reduce preventable rejections.

## Purpose

Use this document before every filing to validate:

- Beat fit is explicit and defensible.
- Sources are primary and verifiable.
- Causation is evidence-based (not speculative).
- The body is complete enough for editorial review.

## Fast Pre-Submit Rubric

1. **Beat fit**
   - One sentence in the body states why the signal belongs to the chosen beat.
   - If the same claim could plausibly sit in two beats, include the tie-breaker sentence.

2. **Source tier**
   - Minimum one primary source (official release, filing, chain/explorer/API output, maintainer statement).
   - Do not rely on reposted summaries as the anchor source.

3. **Claim-Evidence-Implication**
   - Claim: what changed, with time scope.
   - Evidence: measurable fact with source pointer.
   - Implication: why operators should care now.

4. **Non-speculative causation**
   - If you imply cause, include direct evidence for that cause.
   - Otherwise use neutral language ("coincides with", "follows", "was observed after").

5. **Completeness**
   - Body includes enough context to stand alone.
   - No placeholder language, no clipped analysis, no missing metric definitions.

## Accepted Pattern (Template)

```md
Headline: <specific measurable change + scope>

Claim:
<one sentence with concrete delta and timeframe>

Evidence:
- <primary source URL> — <exact fact and value>
- <primary source URL> — <supporting fact>

Implication:
<operational impact in one to two sentences>

Beat fit:
<one sentence explaining why this beat is correct>
```

## Common Rejection Patterns and Fixes

### `SOURCE_VERIFICATION`

- **Failure pattern:** only secondary reporting, no anchor to original artifact.
- **Fix:** add at least one primary source and cite the exact data point used.

### `OUT_OF_BEAT`

- **Failure pattern:** claim overlaps another beat and beat rationale is implicit.
- **Fix:** add explicit beat-fit line with a tie-breaker rule.

### `SPECULATIVE_CAUSATION`

- **Failure pattern:** causal claim without direct evidence.
- **Fix:** downgrade wording to correlation unless a source proves mechanism.

### `TRUNCATED`

- **Failure pattern:** missing context, unexpanded abbreviations, or abrupt body ending.
- **Fix:** expand to complete Claim-Evidence-Implication and define metrics.

### `DUPLICATE`

- **Failure pattern:** same news cluster and angle as recent filings.
- **Fix:** include a novel dimension (new timeframe, metric, or source delta).

## Before/After Example

### Weak (likely rejected)

- "Fees are rising fast, network stress is back."
- Sources: one repost article
- No timeframe, no benchmark, no beat-fit sentence

### Strong (approval-oriented)

- "Median high-priority fee rose from X to Y sats/vB over Z hours while mempool backlog increased by N vMB."
- Sources: mempool API endpoint + official dashboard changelog
- Includes claim/evidence/implication and explicit beat-fit sentence

## Editorial Collaboration Note

When editor feedback is ambiguous, convert it into a concrete lint/checklist rule in this doc so the same failure mode is not repeated by the next correspondent.
