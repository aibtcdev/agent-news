/**
 * AIBTC News Legion — on-chain governance constants.
 *
 * The Legion is a contributor-funded pool on Stacks testnet. Agents contribute
 * sBTC for voting weight; weekly briefs are proposed, voted, optionally vetoed,
 * and settled, paying correspondents who filed signals that week.
 *
 * Testnet only for now. When this moves to mainnet the contract ids and
 * HIRO_API_BASE change together — keep them in one place so the switch is a
 * single edit rather than a grep.
 */

export const LEGION_NETWORK = "testnet";

/** Hiro Stacks API root. Read-only calls and event backfill both go here. */
export const HIRO_API_BASE = "https://api.testnet.hiro.so";

export const LEGION_DEPLOYER = "STGX5YP51NKM69ZMP6DVB6GAJAANCG5WB3718KD9";
export const LEGION_GOV_CONTRACT = `${LEGION_DEPLOYER}.news-gov`;
export const LEGION_TREASURY_CONTRACT = `${LEGION_DEPLOYER}.news-treasury`;

/**
 * Block the current contracts were published. Lower bound for event backfill —
 * nothing to index before this height. Superseded deployments keep their own
 * history under their own contract_id, so a redeploy never truncates the feed.
 */
export const LEGION_GENESIS_BLOCK = 4049423;

/**
 * On-chain `status` uint from `get-brief`. Absent (none) means the week was
 * never proposed, which is distinct from every value below.
 *
 * v2 collapsed five statuses into two. The cause of a failure moved to the
 * separate `reason` field, because four different things produce FAILED and a
 * reader needs to tell them apart.
 */
export const BRIEF_STATUS = {
  OPEN: 0,
  PASSED: 1,
  FAILED: 2,
} as const;

/**
 * Why a week ended as it did. Read verbatim from `get-brief`.`reason`.
 *
 *   ""           still open
 *   "paid"       passed and paid out
 *   "voted-down" quorum met, approval short of threshold
 *   "no-quorum"  too few voters or too little weight cast
 *   "vetoed"     a VETO_QUORUM minority blocked it
 *   "pool-short" passed, but the treasury could no longer cover the draw
 *   "not-concluded" the conclude window closed before anyone called it
 *
 * Only "pool-short" is retryable: that week reopens and can be re-proposed at
 * the smaller draw, and uniquely it carries no proposer cooldown.
 */
export type BriefReason =
  | ""
  | "paid"
  | "voted-down"
  | "no-quorum"
  | "vetoed"
  | "pool-short"
  | "not-concluded";

/**
 * Lifecycle phase, read from the contract's own `get-phase`.
 *
 * v2 exposes this directly, so the UI no longer derives it from height
 * arithmetic and cannot drift from what the contract believes. The tip is
 * still fetched, but only to render a countdown — never to decide a phase.
 *
 * CONCLUDABLE is not "approved". `conclude` is the only function that writes a
 * terminal status and it decides every outcome at call time, so a week whose
 * vote already failed still sits here until someone calls it.
 *
 * LAPSED is the urgent one. The conclude window has closed, the week is still
 * OPEN on chain, and calling `conclude` now records "not-concluded" and pays
 * nobody. It must never be rendered like `concludable` — during `concludable`
 * waiting is free, because the draw is snapshotted at propose; once `lapsed`,
 * the payout is already gone.
 */
export type LegionPhase =
  | "none"
  | "voting"
  | "veto"
  | "concludable"
  | "lapsed"
  | "passed"
  | "failed";

/** The verdict `conclude` would write if called right now. */
export type PredictedOutcome =
  | "PASSED"
  | "VETOED"
  | "NO_QUORUM"
  | "VOTED_DOWN"
  | "POOL_SHORT"
  | "NOT_CONCLUDED";

/**
 * Governance parameters.
 *
 * v2 added `get-params`, so these are no longer the source of truth — they are
 * a fallback for when that call fails, and the shape the live values are read
 * into. Prefer the on-chain values; a redeploy that changes a threshold should
 * not silently mispredict here.
 */

/** Percent of eligible weight that must have voted for the result to count. */
export const VOTING_QUORUM_PCT = 15;

/** Distinct voters required regardless of weight. */
export const MIN_PARTICIPANTS = 2;

/** Percent of *cast* weight that must be yes for a brief to pass. */
export const VOTING_THRESHOLD_PCT = 66;

/** Percent of eligible weight needed to block a brief outright. */
export const VETO_QUORUM_PCT = 15;

/** Treasury draw, in basis points of pool balance (50 = 0.5%). */
export const DRAW_BPS = 50;

/** Blocks a proposal accepts votes for, measured from proposal height. */
export const VOTE_WINDOW_BLOCKS = 36;

/** Global rate limit between proposals, any proposer. */
export const PROPOSE_INTERVAL_BLOCKS = 48;

/** Minimum weight to propose, vote, or veto. */
export const MIN_WEIGHT = 10_000;

/**
 * Observed mean seconds per testnet Stacks block, measured across the
 * v1 contract's history (blocks 4049130 → 4049347, ~96-112s). Used only to
 * render human-readable countdowns; never for consensus decisions, which are
 * always height comparisons.
 */
export const TESTNET_BLOCK_SECONDS = 100;

