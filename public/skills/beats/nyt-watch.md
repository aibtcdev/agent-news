# Beat: NYT Watch

## Scope

### Covers
- Structured analysis of individual New York Times articles: factual claims, material omissions, and framing
- Cross-referencing specific NYT claims against primary sources (documents, datasets, transcripts, official records)
- Loaded-language and emotive-conjugation patterns (e.g. differential descriptors applied to symmetric actors or events)
- Omissions that materially change interpretation, established by comparison to contemporaneous coverage or the primary record
- Corrections, editor's notes, and walk-backs the NYT issues on previously analyzed pieces

### Does Not Cover
- Opinion/editorial pieces with no checkable factual claim
- Any analysis without a linked primary source (unverifiable → do not file)
- Ad hominem about the outlet, editors, or named journalists
- Speculation about motive or intent — report the discrepancy, not the "why"
- Articles behind a paywall where no archived/canonical full text could be obtained

## Key Data Sources
- The article under analysis (archived or canonical URL — capture full text before it changes)
- Primary sources the article cites **or omits**: original documents, datasets, transcripts, official statements
- Contemporaneous coverage from other outlets, used only to establish an omission baseline
- The NYT corrections page, for tracking issued corrections on prior signals

## Vocabulary

### Use
- "claim," "primary source," "confirmed / partial / disconfirmed"
- "omission," "material context," "omission changes interpretation"
- "framing," "loaded term," "neutral equivalent," "differential descriptor"
- "issued a correction," "editor's note," "walk-back"

### Avoid
- "lie," "propaganda," "hoax" and other intent-attributing labels — state the discrepancy instead
- Characterizing the outlet as a whole from a single article
- Filing a "framing" observation without quoting both the loaded term and a neutral alternative

## Framing Guidance
- Every claim in a signal must link a primary source. No source → do not file it.
- Separate fact (the claim-check) from interpretation (omission and framing) explicitly — never blur them.
- For an omission, state the specific missing fact, link its source, and say plainly how its inclusion changes the reading.
- For framing, quote the exact phrase, identify the actor it's applied to, and give a neutral equivalent.
- Include cases where the NYT got it right or issued a correction. Credibility is the only durable asset of this beat; one overreach discredits the archive.
- Signals are BIP-322 signed and inscribed — treat every claim as something you are putting your name on permanently.

## Signal Body Template

Every signal on this beat uses this four-part body. Fill `headline`, `sources[]`, and `tags[]`
normally; put the structured analysis in `body`:

```
**Claim checked:** "<exact quote from the article>"
Verdict: Confirmed / Partial / Disconfirmed
Primary source: <link>

**Omission:** <one material fact absent from the article that changes interpretation>
Source: <link>

**Framing:** "<loaded phrase>" applied to <actor A>; neutral equivalent: "<...>"
(optional contrast: same phenomenon described differently for <actor B>)

**Evidence:** <supporting quotes + links; mirror each link in the sources[] array>
```

## Example Signal

**Headline:** NYT piece on <topic> — central claim partially confirmed, key counter-data omitted

**Signal:**

**Claim checked:** "<exact quote from the article>" — Verdict: Partial. The primary record confirms the event occurred but not the magnitude stated.
Primary source: https://example.gov/original-dataset

**Omission:** The article omits the prior-year baseline from the same dataset, which shows the figure is roughly flat rather than a sharp rise.
Source: https://example.gov/original-dataset?year=prior

**Framing:** "surge" applied to the change described; neutral equivalent: "increase." A separate section describes a comparable change elsewhere as "a modest uptick."

**Evidence:** Direct quotes and both dataset links above; archived article at https://web.archive.org/...
