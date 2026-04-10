/**
 * SQL schema for NewsDO SQLite storage.
 * All tables use CREATE TABLE IF NOT EXISTS for safe re-initialization.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS beats (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  color       TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id                TEXT PRIMARY KEY,
  beat_slug         TEXT NOT NULL REFERENCES beats(slug),
  btc_address       TEXT NOT NULL,
  headline          TEXT NOT NULL,
  body              TEXT,
  sources           TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  correction_of     TEXT,
  status            TEXT NOT NULL DEFAULT 'submitted',
  publisher_feedback TEXT,
  reviewed_at       TEXT,
  disclosure        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS signal_tags (
  signal_id TEXT NOT NULL REFERENCES signals(id),
  tag       TEXT NOT NULL,
  PRIMARY KEY (signal_id, tag)
);

CREATE TABLE IF NOT EXISTS briefs (
  date          TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  json_data     TEXT,
  compiled_at   TEXT NOT NULL,
  inscribed_txid TEXT,
  inscription_id TEXT
);

CREATE TABLE IF NOT EXISTS streaks (
  btc_address      TEXT PRIMARY KEY,
  current_streak   INTEGER NOT NULL DEFAULT 0,
  longest_streak   INTEGER NOT NULL DEFAULT 0,
  last_signal_date TEXT,
  total_signals    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS earnings (
  id          TEXT PRIMARY KEY,
  btc_address TEXT NOT NULL,
  amount_sats INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  reference_id TEXT,
  created_at  TEXT NOT NULL,
  payout_txid TEXT
);

CREATE TABLE IF NOT EXISTS classifieds (
  id           TEXT PRIMARY KEY,
  btc_address  TEXT NOT NULL,
  category     TEXT NOT NULL,
  headline     TEXT NOT NULL,
  body         TEXT,
  payment_txid TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brief_signals (
  brief_date  TEXT NOT NULL,
  signal_id   TEXT NOT NULL,
  btc_address TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (brief_date, signal_id)
);

CREATE TABLE IF NOT EXISTS corrections (
  id           TEXT PRIMARY KEY,
  signal_id    TEXT NOT NULL,
  btc_address  TEXT NOT NULL,
  claim        TEXT NOT NULL,
  correction   TEXT NOT NULL,
  sources      TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  reviewed_by  TEXT,
  reviewed_at  TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS referral_credits (
  id               TEXT PRIMARY KEY,
  scout_address    TEXT NOT NULL,
  recruit_address  TEXT NOT NULL,
  first_signal_id  TEXT,
  credited_at      TEXT,
  created_at       TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_staging (
  payment_id      TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  stage_status    TEXT NOT NULL DEFAULT 'staged',
  payload_json    TEXT NOT NULL,
  terminal_status TEXT,
  terminal_reason TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  finalized_at    TEXT,
  discarded_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_signal_tags_tag          ON signal_tags(tag);
CREATE INDEX IF NOT EXISTS idx_signals_beat_slug        ON signals(beat_slug);
CREATE INDEX IF NOT EXISTS idx_signals_btc_address      ON signals(btc_address);
CREATE INDEX IF NOT EXISTS idx_signals_created_at       ON signals(created_at);
CREATE INDEX IF NOT EXISTS idx_signals_correction_of    ON signals(correction_of);
CREATE INDEX IF NOT EXISTS idx_earnings_btc_address     ON earnings(btc_address);
CREATE INDEX IF NOT EXISTS idx_classifieds_btc_address  ON classifieds(btc_address);
CREATE INDEX IF NOT EXISTS idx_classifieds_expires_at   ON classifieds(expires_at);
CREATE INDEX IF NOT EXISTS idx_classifieds_category     ON classifieds(category);
CREATE INDEX IF NOT EXISTS idx_brief_signals_address    ON brief_signals(btc_address);
CREATE INDEX IF NOT EXISTS idx_brief_signals_date       ON brief_signals(brief_date);
CREATE INDEX IF NOT EXISTS idx_corrections_signal       ON corrections(signal_id);
CREATE INDEX IF NOT EXISTS idx_corrections_address      ON corrections(btc_address);
CREATE INDEX IF NOT EXISTS idx_referral_scout           ON referral_credits(scout_address);
CREATE INDEX IF NOT EXISTS idx_referral_recruit         ON referral_credits(recruit_address);
CREATE INDEX IF NOT EXISTS idx_payment_staging_status   ON payment_staging(stage_status);
`;

/**
 * Migration SQL for existing databases that lack Phase 0 columns.
 * Each statement is wrapped in a try/catch-friendly pattern (columns may already exist).
 * Run via news-do constructor after SCHEMA_SQL.
 */
export const MIGRATION_PHASE0_SQL = [
  "ALTER TABLE signals ADD COLUMN status TEXT NOT NULL DEFAULT 'submitted'",
  "ALTER TABLE signals ADD COLUMN publisher_feedback TEXT",
  "ALTER TABLE signals ADD COLUMN reviewed_at TEXT",
  "ALTER TABLE signals ADD COLUMN disclosure TEXT NOT NULL DEFAULT ''",
  "CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status)",
  "DELETE FROM earnings WHERE reason = 'signal' AND amount_sats = 0",
] as const;

/**
 * sBTC transfer tracking migration.
 * Adds payout_txid to earnings so the Publisher can record an sBTC txid
 * after sending, enabling audit trails for correspondent payouts.
 */
export const MIGRATION_SBTC_TRACKING_SQL = [
  "ALTER TABLE earnings ADD COLUMN payout_txid TEXT",
] as const;

/**
 * Classifieds cleanup migration.
 * Drops the contact column — btc_address already serves as the agent-native contact method.
 */
export const MIGRATION_CLASSIFIEDS_CLEANUP_SQL = [
  "ALTER TABLE classifieds DROP COLUMN contact",
] as const;

/**
 * Payments migration — Phase 4.
 * Adds a partial UNIQUE index on earnings(reason, reference_id) WHERE reference_id
 * IS NOT NULL, preventing double-paying the same correspondent for the same event
 * (brief inclusion or weekly prize). INSERT OR IGNORE is used on payout writes,
 * so duplicates are silently skipped. Rows with NULL reference_id are not constrained.
 */
export const MIGRATION_PAYMENTS_SQL = [
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_earnings_reason_ref ON earnings(reason, reference_id) WHERE reference_id IS NOT NULL",
] as const;

/**
 * Leaderboard snapshots migration — audit infrastructure.
 * Creates a table for point-in-time leaderboard snapshots used for dispute
 * resolution and score verification during prize competitions.
 * The UNIQUE INDEX prevents duplicate snapshots for the same (type, week) pair.
 */
export const MIGRATION_SNAPSHOTS_SQL = [
  `CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
    id            TEXT PRIMARY KEY,
    snapshot_type TEXT NOT NULL,
    week          TEXT,
    snapshot_data TEXT NOT NULL,
    created_at    TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshot_week
     ON leaderboard_snapshots(snapshot_type, week)
     WHERE week IS NOT NULL`,
] as const;

/**
 * Classifieds editorial review migration.
 * Adds status, publisher_feedback, reviewed_at, and refund_txid columns
 * so classifieds go through publisher review before going live.
 * TTL starts from approval (not submission). Backfills existing rows as 'approved'.
 */
export const MIGRATION_CLASSIFIEDS_REVIEW_SQL = [
  "ALTER TABLE classifieds ADD COLUMN status TEXT NOT NULL DEFAULT 'pending_review'",
  "ALTER TABLE classifieds ADD COLUMN publisher_feedback TEXT",
  "ALTER TABLE classifieds ADD COLUMN reviewed_at TEXT",
  "ALTER TABLE classifieds ADD COLUMN refund_txid TEXT",
  "CREATE INDEX IF NOT EXISTS idx_classifieds_status ON classifieds(status)",
  // Backfill: all existing classifieds were created before editorial review existed — mark approved
  "UPDATE classifieds SET status = 'approved' WHERE status = 'pending_review'",
] as const;

export const MIGRATION_PAYMENT_STAGING_SQL = [
  `CREATE TABLE IF NOT EXISTS payment_staging (
    payment_id      TEXT PRIMARY KEY,
    kind            TEXT NOT NULL,
    stage_status    TEXT NOT NULL DEFAULT 'staged',
    payload_json    TEXT NOT NULL,
    terminal_status TEXT,
    terminal_reason TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    finalized_at    TEXT,
    discarded_at    TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_payment_staging_status ON payment_staging(stage_status)",
] as const;

/**
 * Beat restructure migration — Phase 3.
 * Defines the original 17-beat taxonomy agreed by arc0btc, cedarxyz,
 * secret-mars, and tfireubs-ui (issue #97/#102). Superseded by
 * MIGRATION_BEAT_NETWORK_FOCUS_SQL which reduces to 10 beats.
 *
 * Runs as a single transaction (all-or-nothing) to prevent partial
 * migration states where signals reference deleted beats.
 *
 * All statements are idempotent:
 *   Phase A — upsert 6 surviving beats (11 removed beats excluded to
 *             prevent re-creation; handled by network-focus migration)
 *   Phase B — preserve correspondent claims from old beats before deletion
 *   Phase C — remap signals.beat_slug for renames / merges
 *   Phase D — delete old beats no longer in taxonomy
 */
export const MIGRATION_BEAT_RESTRUCTURE_SQL = `
  -- ── Phase A: Upsert 6 surviving canonical beats ─────────────────────────
  -- Uses ON CONFLICT to enforce canonical name/description/color on re-run,
  -- while preserving created_by/created_at from the original row.
  -- NOTE: 11 beats removed by MIGRATION_BEAT_NETWORK_FOCUS_SQL are excluded
  -- here to prevent re-creation on every DO wake.
  INSERT INTO beats (slug, name, description, color, created_by, created_at, updated_at) VALUES
    ('agent-economy',   'Agent Economy',   'Agent-to-agent commerce, x402 payment flows, service marketplaces, classified activity, and agent registration/reputation events.',                                                   '#FF8F00', 'system', datetime('now'), datetime('now')),
    ('agent-trading',   'Agent Trading',   'Autonomous trading strategies, order execution by agents, on-chain position data, and agent-operated liquidity.',                                                                     '#00ACC1', 'system', datetime('now'), datetime('now')),
    ('deal-flow',       'Deal Flow',       'Fundraising rounds, acquisitions, grants, and investment activity in Bitcoin-adjacent companies and protocols.',                                                                       '#8E24AA', 'system', datetime('now'), datetime('now')),
    ('agent-skills',    'Agent Skills',    'New agent capabilities, skill releases, MCP integrations, and tool registrations that expand what agents can do. Capability milestones only.',                                         '#00897B', 'system', datetime('now'), datetime('now')),
    ('agent-social',    'Agent Social',    'Agent and human social coordination — notable threads, community signals, X/Nostr activity, and network discourse worth tracking.',                                                   '#D81B60', 'system', datetime('now'), datetime('now')),
    ('security',        'Security',        'Vulnerability disclosures, protocol exploits, wallet/key security events, contract audit findings, agent-targeted social engineering, and threat intelligence relevant to Bitcoin and Stacks.', '#E53935', 'system', datetime('now'), datetime('now'))
  ON CONFLICT(slug) DO UPDATE SET
    name        = excluded.name,
    description = excluded.description,
    color       = excluded.color,
    updated_at  = datetime('now');

  -- ── Phase B: Preserve correspondent claims from old beats ──────────────
  -- Copy created_by/created_at from old slugs into new slugs so ownership
  -- survives the rename. For merges, the first old slug's claim wins.
  UPDATE beats SET
    created_by = (SELECT created_by FROM beats WHERE slug = 'btc-macro'),
    created_at = (SELECT created_at FROM beats WHERE slug = 'btc-macro')
  WHERE slug = 'bitcoin-macro'
    AND EXISTS (SELECT 1 FROM beats WHERE slug = 'btc-macro')
    AND (SELECT created_by FROM beats WHERE slug = 'btc-macro') != 'system';

  UPDATE beats SET
    created_by = (SELECT created_by FROM beats WHERE slug = 'agent-commerce'),
    created_at = (SELECT created_at FROM beats WHERE slug = 'agent-commerce')
  WHERE slug = 'agent-economy'
    AND EXISTS (SELECT 1 FROM beats WHERE slug = 'agent-commerce')
    AND (SELECT created_by FROM beats WHERE slug = 'agent-commerce') != 'system';

  UPDATE beats SET
    created_by = (SELECT created_by FROM beats WHERE slug = 'network-ops'),
    created_at = (SELECT created_at FROM beats WHERE slug = 'network-ops')
  WHERE slug = 'aibtc-network'
    AND EXISTS (SELECT 1 FROM beats WHERE slug = 'network-ops')
    AND (SELECT created_by FROM beats WHERE slug = 'network-ops') != 'system';

  -- Merges: ordinals-business wins claim for ordinals (first claimant)
  UPDATE beats SET
    created_by = (SELECT created_by FROM beats WHERE slug = 'ordinals-business'),
    created_at = (SELECT created_at FROM beats WHERE slug = 'ordinals-business')
  WHERE slug = 'ordinals'
    AND EXISTS (SELECT 1 FROM beats WHERE slug = 'ordinals-business')
    AND (SELECT created_by FROM beats WHERE slug = 'ordinals-business') != 'system';

  -- protocol-infra claim carries to dev-tools
  UPDATE beats SET
    created_by = (SELECT created_by FROM beats WHERE slug = 'protocol-infra'),
    created_at = (SELECT created_at FROM beats WHERE slug = 'protocol-infra')
  WHERE slug = 'dev-tools'
    AND EXISTS (SELECT 1 FROM beats WHERE slug = 'protocol-infra')
    AND (SELECT created_by FROM beats WHERE slug = 'protocol-infra') != 'system';

  -- agentic-trading claim carries to agent-trading (rename)
  UPDATE beats SET
    created_by = (SELECT created_by FROM beats WHERE slug = 'agentic-trading'),
    created_at = (SELECT created_at FROM beats WHERE slug = 'agentic-trading')
  WHERE slug = 'agent-trading'
    AND EXISTS (SELECT 1 FROM beats WHERE slug = 'agentic-trading')
    AND (SELECT created_by FROM beats WHERE slug = 'agentic-trading') != 'system';

  -- ── Phase C: Remap signals.beat_slug ───────────────────────────────────
  -- Renames: old slug → new slug
  UPDATE signals SET beat_slug = 'bitcoin-macro' WHERE beat_slug = 'btc-macro';
  UPDATE signals SET beat_slug = 'agent-economy' WHERE beat_slug = 'agent-commerce';
  UPDATE signals SET beat_slug = 'aibtc-network' WHERE beat_slug = 'network-ops';
  UPDATE signals SET beat_slug = 'agent-trading' WHERE beat_slug = 'agentic-trading';
  -- Merges: multiple old slugs → single new slug
  UPDATE signals SET beat_slug = 'ordinals' WHERE beat_slug IN ('ordinals-business', 'ordinals-culture');
  UPDATE signals SET beat_slug = 'dev-tools' WHERE beat_slug = 'protocol-infra';
  -- Retirements: remap to closest-fit new beats to preserve signal data
  UPDATE signals SET beat_slug = 'bitcoin-yield' WHERE beat_slug = 'defi-yields';
  UPDATE signals SET beat_slug = 'bitcoin-macro' WHERE beat_slug = 'fee-weather';

  -- ── Phase D: Delete old beats (all signals remapped above) ─────────────
  DELETE FROM beats WHERE slug IN ('btc-macro', 'agent-commerce', 'network-ops', 'ordinals-business', 'ordinals-culture', 'protocol-infra', 'defi-yields', 'fee-weather', 'agentic-trading');
`;

/**
 * Beat claims migration — multi-agent beats.
 * Adds a beat_claims join table that decouples beat membership from beat creation.
 * beats.created_by is preserved as an immutable "founded by" record.
 * beat_claims tracks all active memberships.
 *
 * Migration seeds beat_claims from existing beats.created_by so current
 * owners retain their membership automatically.
 */
export const MIGRATION_BEAT_CLAIMS_SQL = [
  `CREATE TABLE IF NOT EXISTS beat_claims (
    beat_slug    TEXT NOT NULL REFERENCES beats(slug),
    btc_address  TEXT NOT NULL,
    claimed_at   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'active',
    PRIMARY KEY (beat_slug, btc_address)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_beat_claims_address ON beat_claims(btc_address)",
  "CREATE INDEX IF NOT EXISTS idx_beat_claims_status ON beat_claims(status)",
  `INSERT OR IGNORE INTO beat_claims (beat_slug, btc_address, claimed_at, status)
    SELECT slug, created_by, created_at, 'active'
    FROM beats
    WHERE created_by != 'system'`,
] as const;

/**
 * Migration 9 — Retraction support: soft-archive columns for brief_signals and earnings.
 * Allows publisher to retract brief_included signals pre-inscription while preserving
 * the full audit trail (no hard deletes).
 */
export const MIGRATION_RETRACTION_SQL = [
  "ALTER TABLE brief_signals ADD COLUMN retracted_at TEXT",
  "ALTER TABLE earnings ADD COLUMN voided_at TEXT",
] as const;

/**
 * Migration 10 — Network-focus beats.
 * Reduces 17 beats to 10, all focused on aibtc network activity.
 *
 * Removes external beats (bitcoin-macro, bitcoin-culture, bitcoin-yield,
 * ordinals, runes, art, world-intel, comics). Renames aibtc-network →
 * onboarding, dao-watch → governance, dev-tools → infrastructure. Adds
 * distribution beat. Remaps all signals to closest surviving beat.
 *
 * Runs as a single exec() call for atomic write coalescing.
 * All statements are idempotent — safe to re-run.
 */
export const MIGRATION_BEAT_NETWORK_FOCUS_SQL = `
  -- ── Phase A: Upsert 10 network-focused canonical beats ────────────
  INSERT INTO beats (slug, name, description, color, created_by, created_at, updated_at) VALUES
    ('agent-economy',   'Agent Economy',    'Payments, bounties, x402 flows, sBTC transfers between agents, service marketplaces, and agent registration/reputation events.',     '#FF8F00', 'system', datetime('now'), datetime('now')),
    ('agent-trading',   'Agent Trading',    'P2P ordinals, PSBT swaps, order book activity, autonomous trading strategies, on-chain position data, and agent-operated liquidity.', '#00ACC1', 'system', datetime('now'), datetime('now')),
    ('agent-social',    'Agent Social',     'Collaborations, DMs, partnerships, reputation events, and social coordination between agents and humans.',                            '#D81B60', 'system', datetime('now'), datetime('now')),
    ('agent-skills',    'Agent Skills',     'Skills built by agents, PRs, adoption metrics, capability milestones, and tool registrations.',                                       '#00897B', 'system', datetime('now'), datetime('now')),
    ('security',        'Security',         'Vulnerabilities affecting aibtc agents and wallets, contract audit findings, agent-targeted threats, and network security events.',    '#E53935', 'system', datetime('now'), datetime('now')),
    ('deal-flow',       'Deal Flow',        'Bounties, classifieds, sponsorships, contracts, and commercial activity within the aibtc network.',                                   '#8E24AA', 'system', datetime('now'), datetime('now')),
    ('onboarding',      'Onboarding',       'New agent registrations, Genesis achievements, referrals, and first-time network participation events.',                              '#1E88E5', 'system', datetime('now'), datetime('now')),
    ('governance',      'Governance',       'Multisig operations, elections, sBTC staking, DAO proposals, voting outcomes, and signer/council activity.',                           '#7C4DFF', 'system', datetime('now'), datetime('now')),
    ('distribution',    'Distribution',     'Paperboy deliveries, correspondent recruitment, brief metrics, readership, and network content distribution.',                        '#26A69A', 'system', datetime('now'), datetime('now')),
    ('infrastructure',  'Infrastructure',   'MCP server updates, relay health, API changes, protocol releases, and tooling that agents and builders depend on.',                   '#546E7A', 'system', datetime('now'), datetime('now'))
  ON CONFLICT(slug) DO UPDATE SET
    name        = excluded.name,
    description = excluded.description,
    color       = excluded.color,
    updated_at  = datetime('now');

  -- ── Phase B: Preserve correspondent claims across renames ──────────
  -- aibtc-network → onboarding
  UPDATE beats SET
    created_by = (SELECT created_by FROM beats WHERE slug = 'aibtc-network'),
    created_at = (SELECT created_at FROM beats WHERE slug = 'aibtc-network')
  WHERE slug = 'onboarding'
    AND EXISTS (SELECT 1 FROM beats WHERE slug = 'aibtc-network')
    AND (SELECT created_by FROM beats WHERE slug = 'aibtc-network') != 'system';

  -- dao-watch → governance
  UPDATE beats SET
    created_by = (SELECT created_by FROM beats WHERE slug = 'dao-watch'),
    created_at = (SELECT created_at FROM beats WHERE slug = 'dao-watch')
  WHERE slug = 'governance'
    AND EXISTS (SELECT 1 FROM beats WHERE slug = 'dao-watch')
    AND (SELECT created_by FROM beats WHERE slug = 'dao-watch') != 'system';

  -- dev-tools → infrastructure
  UPDATE beats SET
    created_by = (SELECT created_by FROM beats WHERE slug = 'dev-tools'),
    created_at = (SELECT created_at FROM beats WHERE slug = 'dev-tools')
  WHERE slug = 'infrastructure'
    AND EXISTS (SELECT 1 FROM beats WHERE slug = 'dev-tools')
    AND (SELECT created_by FROM beats WHERE slug = 'dev-tools') != 'system';

  -- ── Phase C: Remap signals.beat_slug ───────────────────────────────
  -- Renames (1:1)
  UPDATE signals SET beat_slug = 'onboarding'      WHERE beat_slug = 'aibtc-network';
  UPDATE signals SET beat_slug = 'governance'       WHERE beat_slug = 'dao-watch';
  UPDATE signals SET beat_slug = 'infrastructure'   WHERE beat_slug = 'dev-tools';

  -- Retirements: remap to closest-fit surviving beat
  UPDATE signals SET beat_slug = 'agent-economy'    WHERE beat_slug = 'bitcoin-macro';
  UPDATE signals SET beat_slug = 'agent-social'     WHERE beat_slug = 'bitcoin-culture';
  UPDATE signals SET beat_slug = 'agent-economy'    WHERE beat_slug = 'bitcoin-yield';
  UPDATE signals SET beat_slug = 'agent-trading'    WHERE beat_slug = 'ordinals';
  UPDATE signals SET beat_slug = 'agent-trading'    WHERE beat_slug = 'runes';
  UPDATE signals SET beat_slug = 'agent-trading'    WHERE beat_slug = 'art';
  UPDATE signals SET beat_slug = 'security'         WHERE beat_slug = 'world-intel';
  UPDATE signals SET beat_slug = 'agent-social'     WHERE beat_slug = 'comics';

  -- ── Phase D: Migrate and delete beat_claims, then delete retired beats ─
  -- Migrate claims for renamed beats to new slugs (preserve memberships)
  INSERT OR IGNORE INTO beat_claims (beat_slug, btc_address, claimed_at, status)
    SELECT 'onboarding', btc_address, claimed_at, status
    FROM beat_claims WHERE beat_slug = 'aibtc-network';
  INSERT OR IGNORE INTO beat_claims (beat_slug, btc_address, claimed_at, status)
    SELECT 'governance', btc_address, claimed_at, status
    FROM beat_claims WHERE beat_slug = 'dao-watch';
  INSERT OR IGNORE INTO beat_claims (beat_slug, btc_address, claimed_at, status)
    SELECT 'infrastructure', btc_address, claimed_at, status
    FROM beat_claims WHERE beat_slug = 'dev-tools';

  -- Delete claims for all retired/renamed beats (FK constraint blocks beat delete)
  DELETE FROM beat_claims WHERE beat_slug IN (
    'bitcoin-macro', 'bitcoin-culture', 'bitcoin-yield',
    'ordinals', 'runes', 'art', 'world-intel', 'comics',
    'aibtc-network', 'dao-watch', 'dev-tools'
  );
  DELETE FROM beats WHERE slug IN (
    'bitcoin-macro', 'bitcoin-culture', 'bitcoin-yield',
    'ordinals', 'runes', 'art', 'world-intel', 'comics',
    'aibtc-network', 'dao-watch', 'dev-tools'
  );
`;

/**
 * MIGRATION_BITCOIN_MACRO_SQL — re-adds the bitcoin-macro beat (closes #348).
 *
 * Phase A: Add daily_approved_limit column to beats table. Currently unused —
 *   reserved for future per-beat caps (e.g. limiting approvals per day on
 *   high-volume external beats). NULL = no cap. Column is nullable integer.
 * Phase B: Insert bitcoin-macro beat.
 *
 * Idempotent:
 *   - ALTER TABLE ADD COLUMN is safe to re-run (duplicate column error is caught).
 *   - INSERT ON CONFLICT updates name/description/color on re-run.
 */
export const MIGRATION_BITCOIN_MACRO_SQL = [
  // Phase A: add column — currently unused, reserved for future per-beat daily caps
  `ALTER TABLE beats ADD COLUMN daily_approved_limit INTEGER DEFAULT NULL`,
  // Phase B: re-add the bitcoin-macro beat
  `INSERT INTO beats (slug, name, description, color, created_by, created_at, updated_at) VALUES
    ('bitcoin-macro', 'Bitcoin Macro', 'Broader Bitcoin macroeconomic news: price milestones, ETF flows, institutional adoption, regulatory developments, and macro events relevant to the Bitcoin-native AI economy.', '#F9A825', 'system', datetime('now'), datetime('now'))
  ON CONFLICT(slug) DO UPDATE SET
    name        = excluded.name,
    description = excluded.description,
    color       = excluded.color,
    updated_at  = datetime('now')`,
] as const;

/**
 * MIGRATION_QUANTUM_BEAT_SQL — adds the quantum beat (Part 2 of #348).
 *
 * Covers quantum computing impacts on Bitcoin: hardware advances, threats to
 * ECDSA/SHA-256, post-quantum BIPs, timeline estimates, and quantum-resistant
 * signature schemes.
 *
 * Idempotent: INSERT ON CONFLICT updates name/description/color on re-run.
 */
export const MIGRATION_QUANTUM_BEAT_SQL = `INSERT INTO beats (slug, name, description, color, created_by, created_at, updated_at) VALUES
  ('quantum', 'Quantum', 'Quantum computing and its potential impacts on Bitcoin: hardware and algorithm advances, threats to ECDSA and SHA-256, post-quantum cryptography proposals and BIPs, timeline and risk assessments, and quantum-resistant signature schemes.', '#00BFA5', 'system', datetime('now'), datetime('now'))
ON CONFLICT(slug) DO UPDATE SET
  name        = excluded.name,
  description = excluded.description,
  color       = excluded.color,
  updated_at  = datetime('now')`;

/**
 * MIGRATION_APPROVAL_CAP_INDEX_SQL — adds compound index for daily approval cap (#362).
 * Enables efficient counting of approved/brief_included signals by reviewed_at date range.
 */
export const MIGRATION_APPROVAL_CAP_INDEX_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_signals_status_reviewed ON signals(status, reviewed_at)",
] as const;

/**
 * MIGRATION_BEAT_EDITORS_SQL — beat editor registration table (migration 17).
 *
 * beat_editors tracks which BTC addresses are authorized as editors for each beat.
 * Publisher registers/deactivates editors; editors are scoped to a single beat.
 * status defaults to 'active'; deactivated_at is set on deactivation.
 */
export const MIGRATION_BEAT_EDITORS_SQL = [
  `CREATE TABLE IF NOT EXISTS beat_editors (
    beat_slug      TEXT NOT NULL REFERENCES beats(slug),
    btc_address    TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active',
    registered_at  TEXT NOT NULL,
    registered_by  TEXT NOT NULL,
    deactivated_at TEXT,
    PRIMARY KEY (beat_slug, btc_address)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_beat_editors_address ON beat_editors(btc_address)",
  "CREATE INDEX IF NOT EXISTS idx_beat_editors_status ON beat_editors(status)",
] as const;

/**
 * MIGRATION_EDITORIAL_REVIEWS_SQL — editorial review columns on corrections table (migration 18).
 *
 * Extends corrections to also store editorial reviews (type = 'editorial_review').
 * Editorial reviews include a 0-100 score, factcheck_passed flag, beat_relevance score,
 * and a recommendation (approve/reject/needs_revision).
 * Existing corrections have type defaulted to 'correction' via column default.
 */
export const MIGRATION_EDITORIAL_REVIEWS_SQL = [
  "ALTER TABLE corrections ADD COLUMN type TEXT NOT NULL DEFAULT 'correction'",
  "ALTER TABLE corrections ADD COLUMN score INTEGER",
  "ALTER TABLE corrections ADD COLUMN factcheck_passed INTEGER",
  "ALTER TABLE corrections ADD COLUMN beat_relevance INTEGER",
  "ALTER TABLE corrections ADD COLUMN recommendation TEXT",
  "CREATE INDEX IF NOT EXISTS idx_corrections_type ON corrections(type)",
] as const;

/**
 * MIGRATION_EDITOR_REVIEW_RATE_SQL — per-beat editor review rate (migration 19).
 *
 * Adds editor_review_rate_sats column to beats table.
 * NULL means no per-beat rate configured (publisher uses ad-hoc amounts).
 * When set, this is the canonical per-review payout to editors on this beat.
 */
export const MIGRATION_EDITOR_REVIEW_RATE_SQL = [
  "ALTER TABLE beats ADD COLUMN editor_review_rate_sats INTEGER DEFAULT NULL",
] as const;

/**
 * MIGRATION_CURATION_CLEANUP_SQL — fixes Mar 28-29 brief curation data (#339).
 *
 * 1. Updates inscription IDs to the amended (curated 30-signal) versions.
 * 2. Voids orphaned earnings from the over-sized original briefs that were
 *    never paid out (no payout_txid) and not already voided.
 *
 * The voided_at timestamp uses 2026-03-31T03:00:00Z — the date the manual
 * curation cleanup was performed.
 */
export const MIGRATION_CURATION_CLEANUP_SQL = [
  // Mar 28 amended inscription
  `UPDATE briefs SET inscription_id = '7cad42fa601bd0525e1e76a3e85d5898b6bdc1d71ee093854b7a7074b2b28abei0'
   WHERE date = '2026-03-28'
     AND inscription_id != '7cad42fa601bd0525e1e76a3e85d5898b6bdc1d71ee093854b7a7074b2b28abei0'`,
  // Mar 29 amended inscription
  `UPDATE briefs SET inscription_id = '07b3788e2dc67733f4bc8f59af841afcb24ef2a7f911581a2010bf7a963caf93i0'
   WHERE date = '2026-03-29'
     AND inscription_id != '07b3788e2dc67733f4bc8f59af841afcb24ef2a7f911581a2010bf7a963caf93i0'`,
  // Void unpaid Mar 28 earnings (compiled ~2026-03-29T04:16Z) excluding the 30 curated signals
  `UPDATE earnings SET voided_at = '2026-03-31T03:00:00Z'
   WHERE reason = 'brief_inclusion'
     AND payout_txid IS NULL AND voided_at IS NULL
     AND created_at >= '2026-03-29T04:00:00Z' AND created_at < '2026-03-29T05:00:00Z'
     AND reference_id NOT IN (
       '930e1834-bef4-4e3f-a68a-3056477af468','1d6ece26-797b-43f7-b1e6-567ed87c631e','cb493430-5d9e-4e49-a725-2f1be7bb08ab','111d8292-8ab5-40e3-bc3b-208db92632c0','98a4d814-00b7-451a-968c-d976220cc7c5','c1343c15-e4b7-4298-9a39-4f8d00bee54d','82a50ffb-c6bf-4fd4-867b-6f0d67365bb6','0ed8c332-cc91-4a24-bc72-9490f5dc0822','9a892709-772e-496f-afe7-9185cce91c86','20bb3ede-6ecf-4b2a-a69f-122c4b57c613','0c4f667c-524d-40db-aecc-f0ef18c55de9','31981975-a6a3-4586-b2d4-870015b7f677','0a14999b-60bd-4fe4-ab7f-753dd9ceda75','b538613c-808b-444e-a31a-02b2579488c2','dc8792d8-f914-4efc-83c7-e340f649d530','6a9d716c-379c-4774-9c24-f8e76f73997a','01c0bedb-2b39-40bf-b686-411384054f1d','b5a3c5f6-4a3f-4637-af37-5a9f79e91c90','18dc8c21-1def-44f9-a2af-8d0a4074e89b','ad79de32-4646-4848-aa17-edb31c327465','55c5e5e6-92e9-43e3-8d8a-f264e4bcc043','f557dc4d-fc45-4fa7-af2d-a0288e9df9ed','9e5879c7-97ce-4f1c-a8fb-b032668fd255','575a3d65-4af8-43de-a65a-61fde6952df8','65a12c02-3b2c-4cdc-9574-a008ec360464','76f8d1e0-6d87-459f-9886-1480533dbcb1','d0cb7dcf-e49c-4bae-aba4-5cd73108f332','b59401dc-f81a-4c18-ba1e-d1c8013a9e8d','029c697b-40de-47d3-a48b-e7954acf93ed','e949fdb2-f75d-40d9-934f-13e8c4f0ed30'
     )`,
  // Void unpaid Mar 29 earnings (compiled ~2026-03-30T09:52Z) excluding the 30 curated signals
  `UPDATE earnings SET voided_at = '2026-03-31T03:00:00Z'
   WHERE reason = 'brief_inclusion'
     AND payout_txid IS NULL AND voided_at IS NULL
     AND created_at >= '2026-03-30T09:00:00Z' AND created_at < '2026-03-30T10:00:00Z'
     AND reference_id NOT IN (
       'db837a01-788d-4f08-a174-8758347ce61a','ffcb4de3-3998-4265-a8a2-eb8944f4af32','43800ead-c4bd-46ef-95f2-5cd1a1ae50a9','80e3529a-a4e9-4cd5-b41c-bcb701a0ba53','2b4cfe7a-75d0-4ce0-906a-bff3e09185cc','2e00e3ef-a979-4583-b010-7565d9b8e635','31cf9975-c3af-44d5-ba5c-b7e5f11375af','dc06393c-f1e0-4667-8ee0-3a593f39ff2c','248db72c-6082-43ca-8500-3c39b013c5e2','f74eb37a-cfba-47d4-adc9-06b62422e2b8','cef57500-2ee9-4c12-82eb-5cb3f8f03e52','3960c10e-92f8-43f6-b8bb-58f768dc5fc0','40d30fbb-459b-49ea-8f94-98b2c8d17a0c','52fadd57-8847-46a8-85e7-d8458f86374e','747ef5c5-30fc-4bff-a555-d52b982dcd4d','cb05bbc3-ed0c-4f77-8ec3-5c7e916bd796','772617b2-2c1b-4f61-bb50-2203b623787a','a1518f55-d566-47d0-a397-35ef9a50efd4','7d995511-db66-400c-8d26-ad198c985281','9f6d8223-aeb5-4de0-b2ab-1ecff104dcdc','545f7829-a536-464c-9417-6c06fa26d02a','bcd9e7ef-992c-4a80-b788-c7000fba15c7','14305d91-2348-4299-b26d-3a4bfebd2909','41bf9018-b15e-4995-9699-fcdb9357634f','b5e4f967-76f5-4012-9c64-c6369f010482','4f5f50e0-60f6-4901-aae7-a0468c61234b','8b866fc7-e02d-4a6f-ba88-fed94434466b','10c5c979-a1e9-45d8-92a4-59fe7d70bd2a','246983df-bd20-4d24-8dce-88b526284e82','45c3be21-17b1-41ca-ab18-82a2ec165146'
     )`,
] as const;

/**
 * Migration 21 — Leaderboard composite indexes.
 * Adds composite indexes to accelerate the 30-day rolling window subqueries
 * in queryLeaderboard(). Without these, each LEFT JOIN subquery performs a
 * full table scan on every leaderboard request (10s+ for tables with 1k+ rows).
 *
 * Indexes added:
 *   - signals(correction_of, created_at)      — covers the correction_of IS NULL + 30-day filter
 *   - brief_signals(created_at, retracted_at)  — covers the 30-day window + retracted_at IS NULL filter
 *   - corrections(status, created_at)          — covers the status='approved' + 30-day filter
 *   - referral_credits(credited_at)            — covers the credited_at IS NOT NULL + 30-day filter
 *
 * Expected improvement: 5–10 s → <500 ms per arc0btc's analysis (issue #319).
 */
export const MIGRATION_LEADERBOARD_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_signals_correction_created ON signals(correction_of, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_brief_signals_created_retracted ON brief_signals(created_at, retracted_at)",
  "CREATE INDEX IF NOT EXISTS idx_corrections_status_created ON corrections(status, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_referral_credits_credited ON referral_credits(credited_at)",
] as const;

/**
 * Migration 22 — Beat consolidation: 12 → 3 (closes #423).
 *
 * Clean cutover: creates aibtc-network beat fresh, retires the 10 old
 * network-focused beats. Historical signals stay on their original beat_slug
 * (no remapping). New signals can only be filed to the 3 surviving beats.
 *
 * Phase A: Add stored status column to beats table as a retirement marker;
 *   active/inactive status continues to be computed at runtime from recent
 *   signal activity, while stored status is used to force "retired".
 * Phase B: Create aibtc-network beat.
 * Phase C: Retire the 10 old beats.
 *
 * Idempotent: ALTER TABLE catches duplicate column; INSERT ON CONFLICT updates;
 *   UPDATE is safe to re-run on already-retired beats.
 */
export const MIGRATION_BEAT_CONSOLIDATION_SQL = [
  // Phase A: add status column — existing beats default to 'active'
  "ALTER TABLE beats ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
  // Phase B: create aibtc-network beat
  `INSERT INTO beats (slug, name, description, color, created_by, created_at, updated_at, status) VALUES
    ('aibtc-network', 'AIBTC Network', 'Everything happening inside the aibtc ecosystem — agents, skills, trading, governance, infrastructure, security, onboarding, deal flow, distribution, and the agent economy.', '#1E88E5', 'system', datetime('now'), datetime('now'), 'active')
  ON CONFLICT(slug) DO UPDATE SET
    name        = excluded.name,
    description = excluded.description,
    color       = excluded.color,
    status      = 'active',
    updated_at  = datetime('now')`,
  // Phase C: retire the 10 old network-focused beats
  `UPDATE beats SET status = 'retired', updated_at = datetime('now')
   WHERE slug IN ('agent-economy', 'agent-skills', 'agent-social', 'agent-trading', 'deal-flow', 'distribution', 'governance', 'infrastructure', 'onboarding', 'security')`,
] as const;
