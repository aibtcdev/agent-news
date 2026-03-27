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
