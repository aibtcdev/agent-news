/**
 * Scoring math integration tests.
 *
 * Seeds known data directly into the DO (via POST /api/test-seed) and asserts
 * exact leaderboard scores for each scoring component and edge case.
 *
 * All tests in this file share one fresh DO instance. Each test group uses a
 * unique BTC address prefix to prevent cross-test contamination.
 *
 * Scoring formula (from queryLeaderboard in news-do.ts):
 *   score = brief_inclusions   * SCORING_WEIGHTS.brief_inclusions   (20)
 *         + signal_count       * SCORING_WEIGHTS.signal_count        (5)
 *         + current_streak     * SCORING_WEIGHTS.current_streak      (5)
 *         + days_active        * SCORING_WEIGHTS.days_active         (2)
 *         + approved_corrections * SCORING_WEIGHTS.approved_corrections (15)
 *         + referral_credits   * SCORING_WEIGHTS.referral_credits    (25)
 */

import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { SCORING_WEIGHTS } from "../lib/constants";

// ── Timestamp helpers ────────────────────────────────────────────────────────

/** 5 days ago — well within the 30-day rolling window. */
function recentTs(offsetDays = 5): string {
  return new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000).toISOString();
}

/** 35 days ago — outside the 30-day rolling window. */
function oldTs(): string {
  return new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
}

/** 29 days ago — inside the 30-day rolling window. */
function boundaryInsideTs(): string {
  return new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString();
}

/** 32 days ago — safely outside the 30-day rolling window.
 * Note: the window boundary check uses SQLite's datetime() which produces
 * 'YYYY-MM-DD HH:MM:SS' format, while stored timestamps use ISO 'YYYY-MM-DDTHH:MM:SS.sssZ'.
 * String comparison works correctly when date prefixes differ (as they do here).
 */
function boundaryOutsideTs(): string {
  return new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString();
}

// ── API helpers ──────────────────────────────────────────────────────────────

type SeedPayload = {
  signals?: Array<{
    id: string;
    beat_slug: string;
    btc_address: string;
    headline: string;
    sources?: string;
    created_at: string;
    status?: string;
    correction_of?: string | null;
  }>;
  brief_signals?: Array<{
    brief_date: string;
    signal_id: string;
    btc_address: string;
    created_at: string;
    position?: number;
  }>;
  corrections?: Array<{
    id: string;
    signal_id: string;
    btc_address: string;
    claim?: string;
    correction?: string;
    status: string;
    created_at: string;
  }>;
  referral_credits?: Array<{
    id: string;
    scout_address: string;
    recruit_address: string;
    credited_at: string;
    created_at: string;
  }>;
  streaks?: Array<{
    btc_address: string;
    current_streak: number;
    longest_streak: number;
    last_signal_date: string;
    total_signals: number;
  }>;
  leaderboard_snapshots?: Array<{
    id: string;
    snapshot_type: string;
    week?: string | null;
    snapshot_data?: string;
    created_at: string;
  }>;
};

async function seed(payload: SeedPayload): Promise<void> {
  const res = await SELF.fetch("http://example.com/api/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Seed failed (${res.status}): ${text}`);
  }
}

type LeaderboardResponseEntry = {
  address: string;
  score: number;
  breakdown: {
    briefInclusions: number;
    signalCount: number;
    currentStreak: number;
    daysActive: number;
    approvedCorrections: number;
    referralCredits: number;
  };
};

async function getLeaderboard(): Promise<LeaderboardResponseEntry[]> {
  const res = await SELF.fetch("http://example.com/api/leaderboard");
  expect(res.status).toBe(200);
  const body = await res.json<{ leaderboard: LeaderboardResponseEntry[]; total: number }>();
  return body.leaderboard;
}

function findEntry(
  leaderboard: LeaderboardResponseEntry[],
  address: string
): LeaderboardResponseEntry | undefined {
  return leaderboard.find((e) => e.address === address);
}

// ── Address constants ─────────────────────────────────────────────────────────
// Unique per test group to avoid cross-contamination (all tests share one DO).
// Using real bech32-format addresses derived from known test vectors.

const ADDR_BRIEF   = "bc1qbrief00000000000000000000000000000000000"; // brief_inclusions group
const ADDR_SIG     = "bc1qsignal0000000000000000000000000000000000"; // signal_count group
const ADDR_STREAK  = "bc1qstreak0000000000000000000000000000000000"; // streak group
const ADDR_DAYS    = "bc1qdays000000000000000000000000000000000000"; // days_active group
const ADDR_CORR    = "bc1qcorr000000000000000000000000000000000000"; // corrections group
const ADDR_CORR_SIG = "bc1qcorrsig00000000000000000000000000000000"; // signal owner for corrections
const ADDR_REF     = "bc1qreferral0000000000000000000000000000000";  // referrals group
const ADDR_REF_REC = "bc1qrefrecruit000000000000000000000000000000"; // referral recruits prefix base
const ADDR_SAMEDAY = "bc1qsamedayy0000000000000000000000000000000";  // same-day signals
const ADDR_EXCL    = "bc1qcorrexcl0000000000000000000000000000000";  // correction exclusion
const ADDR_REFOUT  = "bc1qrefout00000000000000000000000000000000";   // referral outside window
const ADDR_REFOUT_R = "bc1qrefoutrecr000000000000000000000000000000"; // refout recruit
const ADDR_BND_IN  = "bc1qboundaryin000000000000000000000000000000"; // boundary inside
const ADDR_BND_OUT = "bc1qboundaryout00000000000000000000000000000"; // boundary outside
const ADDR_TWIN_A  = "bc1qtwinaddra000000000000000000000000000000";  // identical score twin A
const ADDR_TWIN_B  = "bc1qtwincountrb000000000000000000000000000000"; // identical score twin B
const ADDR_TWIN_RA = "bc1qtwinreca0000000000000000000000000000000";  // twin A recruit
const ADDR_TWIN_RB = "bc1qtwinrecb0000000000000000000000000000000";  // twin B recruit
const ADDR_ALL     = "bc1qallcomponent0000000000000000000000000000"; // all-components combined
const ADDR_ALL_SIG = "bc1qallcompsig000000000000000000000000000000"; // signal for ALL's correction
const ADDR_ALL_REC = "bc1qallcomprec000000000000000000000000000000"; // recruit for ALL's referral

// Reset epoch test addresses
const ADDR_RESET_PRE  = "bc1qresetpre0000000000000000000000000000000"; // signals before reset
const ADDR_RESET_POST = "bc1qresetpost000000000000000000000000000000"; // signals after reset

// Tie-breaking test addresses — 44 chars each, unique prefix "tb" to avoid collisions.
// For each scenario the "loser" address sorts BEFORE the "winner" alphabetically ('l' < 'w'),
// so if the tiebreaker works, the winner must rank higher despite losing the btc_address sort.
const ADDR_TB_STK_WINNER = "bc1qtbstkwinner00000000000000000000000000000"; // streak=5, sorts AFTER loser
const ADDR_TB_STK_LOSER  = "bc1qtbstkloser000000000000000000000000000000"; // streak=2, sorts BEFORE winner
const ADDR_TB_CORR_SIG   = "bc1qtbcorrsig0000000000000000000000000000000"; // signal source for STK_LOSER correction
const ADDR_TB_TEN_WINNER = "bc1qtbtenwinnerr0000000000000000000000000000"; // earliest signal, sorts AFTER loser
const ADDR_TB_TEN_LOSER  = "bc1qtbtenloser000000000000000000000000000000"; // later signal, sorts BEFORE winner
const ADDR_TB_ALP_A      = "bc1qtbalphaaaaa00000000000000000000000000000"; // same score/streak/tenure, sorts first
const ADDR_TB_ALP_B      = "bc1qtbalphabbbbb0000000000000000000000000000"; // same score/streak/tenure, sorts second

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("brief_inclusions: weight x" + SCORING_WEIGHTS.brief_inclusions, () => {
  it("correctly weights brief inclusions in the score", async () => {
    const signalId1 = "brief-signal-001";
    const signalId2 = "brief-signal-002";
    const ts = recentTs();

    await seed({
      // brief_signals looks up btc_address from signals table via signal_id,
      // so we need signals to exist for the FK lookup. Status doesn't matter here.
      signals: [
        { id: signalId1, beat_slug: "bitcoin-macro", btc_address: ADDR_BRIEF, headline: "Brief signal 1", created_at: ts },
        { id: signalId2, beat_slug: "bitcoin-macro", btc_address: ADDR_BRIEF, headline: "Brief signal 2", created_at: recentTs(4) },
      ],
      brief_signals: [
        { brief_date: "2026-03-20", signal_id: signalId1, btc_address: ADDR_BRIEF, created_at: ts },
        { brief_date: "2026-03-21", signal_id: signalId2, btc_address: ADDR_BRIEF, created_at: recentTs(4) },
      ],
    });

    const leaderboard = await getLeaderboard();
    const entry = findEntry(leaderboard, ADDR_BRIEF);
    expect(entry).toBeDefined();
    expect(entry!.breakdown.briefInclusions).toBe(2);
    // Score contribution from brief_inclusions only (signal_count also adds):
    // brief: 2 * 20 = 40, signals: 2 * 5 = 10, days: 2 * 2 = 4 => total = 54
    const expectedScore =
      2 * SCORING_WEIGHTS.brief_inclusions +
      2 * SCORING_WEIGHTS.signal_count +
      2 * SCORING_WEIGHTS.days_active;
    expect(entry!.score).toBe(expectedScore);
  });
});

describe("signal_count: weight x" + SCORING_WEIGHTS.signal_count, () => {
  it("correctly weights signal count in the score", async () => {
    const ts1 = recentTs(3);
    const ts2 = recentTs(6);
    const ts3 = recentTs(9);

    await seed({
      signals: [
        { id: "sig-count-001", beat_slug: "bitcoin-macro", btc_address: ADDR_SIG, headline: "Signal 1", created_at: ts1 },
        { id: "sig-count-002", beat_slug: "bitcoin-macro", btc_address: ADDR_SIG, headline: "Signal 2", created_at: ts2 },
        { id: "sig-count-003", beat_slug: "bitcoin-macro", btc_address: ADDR_SIG, headline: "Signal 3", created_at: ts3 },
      ],
    });

    const leaderboard = await getLeaderboard();
    const entry = findEntry(leaderboard, ADDR_SIG);
    expect(entry).toBeDefined();
    expect(entry!.breakdown.signalCount).toBe(3);
    // score = 3 * 5 (signal_count) + 3 * 2 (days_active) = 15 + 6 = 21
    const expectedScore =
      3 * SCORING_WEIGHTS.signal_count +
      3 * SCORING_WEIGHTS.days_active;
    expect(entry!.score).toBe(expectedScore);
  });
});

describe("current_streak: weight x" + SCORING_WEIGHTS.current_streak, () => {
  it("correctly weights current streak in the score", async () => {
    const ts = recentTs();

    await seed({
      signals: [
        { id: "streak-signal-001", beat_slug: "bitcoin-macro", btc_address: ADDR_STREAK, headline: "Streak signal", created_at: ts },
      ],
      streaks: [
        {
          btc_address: ADDR_STREAK,
          current_streak: 4,
          longest_streak: 7,
          last_signal_date: ts.slice(0, 10),
          total_signals: 10,
        },
      ],
    });

    const leaderboard = await getLeaderboard();
    const entry = findEntry(leaderboard, ADDR_STREAK);
    expect(entry).toBeDefined();
    expect(entry!.breakdown.currentStreak).toBe(4);
    // score = 1*5 (signal) + 4*5 (streak) + 1*2 (days) = 5 + 20 + 2 = 27
    const expectedScore =
      1 * SCORING_WEIGHTS.signal_count +
      4 * SCORING_WEIGHTS.current_streak +
      1 * SCORING_WEIGHTS.days_active;
    expect(entry!.score).toBe(expectedScore);
  });
});

describe("days_active: weight x" + SCORING_WEIGHTS.days_active, () => {
  it("correctly weights distinct active days in the score", async () => {
    // Three signals on three different days
    const ts1 = recentTs(3);
    const ts2 = recentTs(6);
    const ts3 = recentTs(9);

    await seed({
      signals: [
        { id: "days-signal-001", beat_slug: "bitcoin-macro", btc_address: ADDR_DAYS, headline: "Day 1 signal", created_at: ts1 },
        { id: "days-signal-002", beat_slug: "bitcoin-macro", btc_address: ADDR_DAYS, headline: "Day 2 signal", created_at: ts2 },
        { id: "days-signal-003", beat_slug: "bitcoin-macro", btc_address: ADDR_DAYS, headline: "Day 3 signal", created_at: ts3 },
      ],
    });

    const leaderboard = await getLeaderboard();
    const entry = findEntry(leaderboard, ADDR_DAYS);
    expect(entry).toBeDefined();
    expect(entry!.breakdown.daysActive).toBe(3);
    // score = 3 * 5 (signal) + 3 * 2 (days) = 15 + 6 = 21
    const expectedScore =
      3 * SCORING_WEIGHTS.signal_count +
      3 * SCORING_WEIGHTS.days_active;
    expect(entry!.score).toBe(expectedScore);
  });
});

describe("approved_corrections: weight x" + SCORING_WEIGHTS.approved_corrections, () => {
  it("correctly weights approved corrections in the score", async () => {
    const ts = recentTs();

    // Need a signal owned by ADDR_CORR_SIG for corrections to reference
    // The leaderboard FROM clause is: SELECT DISTINCT btc_address FROM signals WHERE correction_of IS NULL
    // ADDR_CORR must have at least one non-correction signal to appear in the FROM subquery.
    await seed({
      signals: [
        // Signal owned by ADDR_CORR_SIG — referenced by the corrections
        { id: "corrsig-001", beat_slug: "bitcoin-macro", btc_address: ADDR_CORR_SIG, headline: "Signal to correct", created_at: ts },
        // Base signal for ADDR_CORR so it appears in the FROM subquery
        { id: "corr-base-001", beat_slug: "bitcoin-macro", btc_address: ADDR_CORR, headline: "CORR base signal", created_at: ts },
      ],
      // ADDR_CORR files corrections against ADDR_CORR_SIG's signal
      corrections: [
        { id: "corr-001", signal_id: "corrsig-001", btc_address: ADDR_CORR, status: "approved", created_at: ts },
        { id: "corr-002", signal_id: "corrsig-001", btc_address: ADDR_CORR, status: "approved", created_at: recentTs(8) },
      ],
    });

    const leaderboard = await getLeaderboard();
    const entry = findEntry(leaderboard, ADDR_CORR);
    expect(entry).toBeDefined();
    expect(entry!.breakdown.approvedCorrections).toBe(2);
    // score = 1*5 (signal) + 2*15 (corrections) + 1*2 (days) = 5 + 30 + 2 = 37
    const expectedScore =
      1 * SCORING_WEIGHTS.signal_count +
      2 * SCORING_WEIGHTS.approved_corrections +
      1 * SCORING_WEIGHTS.days_active;
    expect(entry!.score).toBe(expectedScore);
  });
});

describe("referral_credits: weight x" + SCORING_WEIGHTS.referral_credits, () => {
  it("correctly weights referral credits in the score", async () => {
    const ts = recentTs();

    await seed({
      signals: [
        { id: "ref-base-001", beat_slug: "bitcoin-macro", btc_address: ADDR_REF, headline: "Ref base signal", created_at: ts },
      ],
      referral_credits: [
        { id: "ref-cred-001", scout_address: ADDR_REF, recruit_address: ADDR_REF_REC + "1", credited_at: ts, created_at: ts },
        { id: "ref-cred-002", scout_address: ADDR_REF, recruit_address: ADDR_REF_REC + "2", credited_at: recentTs(7), created_at: recentTs(7) },
        { id: "ref-cred-003", scout_address: ADDR_REF, recruit_address: ADDR_REF_REC + "3", credited_at: recentTs(14), created_at: recentTs(14) },
      ],
    });

    const leaderboard = await getLeaderboard();
    const entry = findEntry(leaderboard, ADDR_REF);
    expect(entry).toBeDefined();
    expect(entry!.breakdown.referralCredits).toBe(3);
    // score = 1*5 (signal) + 3*25 (referrals) + 1*2 (days) = 5 + 75 + 2 = 82
    const expectedScore =
      1 * SCORING_WEIGHTS.signal_count +
      3 * SCORING_WEIGHTS.referral_credits +
      1 * SCORING_WEIGHTS.days_active;
    expect(entry!.score).toBe(expectedScore);
  });
});

describe("edge case: same-day multi-signals count as 1 days_active", () => {
  it("three signals on the same date produce days_active=1", async () => {
    // Use the same date-prefix to ensure same SQLite date() value
    const sameDate = "2026-03-10";
    const ts1 = sameDate + "T08:00:00.000Z";
    const ts2 = sameDate + "T12:00:00.000Z";
    const ts3 = sameDate + "T20:00:00.000Z";

    await seed({
      signals: [
        { id: "sameday-001", beat_slug: "bitcoin-macro", btc_address: ADDR_SAMEDAY, headline: "Morning signal", created_at: ts1 },
        { id: "sameday-002", beat_slug: "bitcoin-macro", btc_address: ADDR_SAMEDAY, headline: "Noon signal", created_at: ts2 },
        { id: "sameday-003", beat_slug: "bitcoin-macro", btc_address: ADDR_SAMEDAY, headline: "Evening signal", created_at: ts3 },
      ],
    });

    const leaderboard = await getLeaderboard();
    const entry = findEntry(leaderboard, ADDR_SAMEDAY);
    expect(entry).toBeDefined();
    expect(entry!.breakdown.signalCount).toBe(3);
    expect(entry!.breakdown.daysActive).toBe(1);
  });
});

describe("edge case: correction signals excluded from signal_count", () => {
  it("signals with correction_of IS NOT NULL are excluded from signal_count", async () => {
    const ts = recentTs();

    await seed({
      signals: [
        // One regular signal (correction_of: null) → counts in signal_count
        { id: "excl-normal-001", beat_slug: "bitcoin-macro", btc_address: ADDR_EXCL, headline: "Normal signal", created_at: ts, correction_of: null },
        // Two correction signals (correction_of set) → excluded from signal_count AND from FROM clause
        { id: "excl-corr-001", beat_slug: "bitcoin-macro", btc_address: ADDR_EXCL, headline: "Correction 1", created_at: recentTs(3), correction_of: "some-original-id" },
        { id: "excl-corr-002", beat_slug: "bitcoin-macro", btc_address: ADDR_EXCL, headline: "Correction 2", created_at: recentTs(6), correction_of: "some-original-id" },
      ],
    });

    const leaderboard = await getLeaderboard();
    const entry = findEntry(leaderboard, ADDR_EXCL);
    expect(entry).toBeDefined();
    // Only the non-correction signal counts
    expect(entry!.breakdown.signalCount).toBe(1);
    // Only 1 active day (the day of the non-correction signal)
    expect(entry!.breakdown.daysActive).toBe(1);
  });
});

describe("edge case: referral credited_at outside 30-day window not counted", () => {
  it("only referrals with credited_at within 30 days are counted", async () => {
    const ts = recentTs();
    const outsideTs = oldTs();

    await seed({
      signals: [
        { id: "refout-base-001", beat_slug: "bitcoin-macro", btc_address: ADDR_REFOUT, headline: "Refout base signal", created_at: ts },
      ],
      referral_credits: [
        // Inside window — counts
        { id: "refout-cred-001", scout_address: ADDR_REFOUT, recruit_address: ADDR_REFOUT_R + "1", credited_at: ts, created_at: ts },
        // Outside window — does NOT count
        { id: "refout-cred-002", scout_address: ADDR_REFOUT, recruit_address: ADDR_REFOUT_R + "2", credited_at: outsideTs, created_at: outsideTs },
      ],
    });

    const leaderboard = await getLeaderboard();
    const entry = findEntry(leaderboard, ADDR_REFOUT);
    expect(entry).toBeDefined();
    expect(entry!.breakdown.referralCredits).toBe(1);
  });
});

describe("edge case: 30-day boundary — signal just inside window counts", () => {
  it("signal at 29 days ago is included in signal_count", async () => {
    const ts = boundaryInsideTs();

    await seed({
      signals: [
        { id: "bndin-signal-001", beat_slug: "bitcoin-macro", btc_address: ADDR_BND_IN, headline: "Boundary inside signal", created_at: ts },
      ],
    });

    const leaderboard = await getLeaderboard();
    const entry = findEntry(leaderboard, ADDR_BND_IN);
    expect(entry).toBeDefined();
    expect(entry!.breakdown.signalCount).toBe(1);
  });
});

describe("edge case: 30-day boundary — signal just outside window not counted", () => {
  it("signal at 32 days ago is excluded from signal_count", async () => {
    const ts = boundaryOutsideTs();

    await seed({
      signals: [
        { id: "bndout-signal-001", beat_slug: "bitcoin-macro", btc_address: ADDR_BND_OUT, headline: "Boundary outside signal", created_at: ts },
      ],
    });

    const leaderboard = await getLeaderboard();
    const entry = findEntry(leaderboard, ADDR_BND_OUT);
    // The address appears in FROM because the epoch defaults to 1970 (no reset),
    // but signal_count and days_active use the 30-day rolling window.
    expect(entry).toBeDefined();
    expect(entry!.breakdown.signalCount).toBe(0);
    expect(entry!.breakdown.daysActive).toBe(0);
    expect(entry!.score).toBe(0);
  });
});

describe("edge case: two scouts with identical raw values produce identical scores", () => {
  it("twin scouts with same signal/referral counts have equal scores", async () => {
    const ts = recentTs();

    await seed({
      signals: [
        { id: "twin-sig-a-001", beat_slug: "bitcoin-macro", btc_address: ADDR_TWIN_A, headline: "Twin A signal", created_at: ts },
        { id: "twin-sig-b-001", beat_slug: "bitcoin-macro", btc_address: ADDR_TWIN_B, headline: "Twin B signal", created_at: ts },
      ],
      referral_credits: [
        { id: "twin-ref-a-001", scout_address: ADDR_TWIN_A, recruit_address: ADDR_TWIN_RA, credited_at: ts, created_at: ts },
        { id: "twin-ref-b-001", scout_address: ADDR_TWIN_B, recruit_address: ADDR_TWIN_RB, credited_at: ts, created_at: ts },
      ],
      streaks: [
        { btc_address: ADDR_TWIN_A, current_streak: 3, longest_streak: 3, last_signal_date: ts.slice(0, 10), total_signals: 1 },
        { btc_address: ADDR_TWIN_B, current_streak: 3, longest_streak: 3, last_signal_date: ts.slice(0, 10), total_signals: 1 },
      ],
    });

    const leaderboard = await getLeaderboard();
    const entryA = findEntry(leaderboard, ADDR_TWIN_A);
    const entryB = findEntry(leaderboard, ADDR_TWIN_B);
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();
    expect(entryA!.score).toBe(entryB!.score);
    // Verify the score is non-zero
    expect(entryA!.score).toBeGreaterThan(0);
  });
});

describe("tiebreak: same score, higher current_streak ranks first", () => {
  it("scout with streak=5 outranks scout with streak=2 when scores are equal", async () => {
    // Both scouts have the same total score (32 pts) despite different streaks:
    //   STK_WINNER: 1 signal (5) + streak=5 (25) + 1 day (2) = 32
    //   STK_LOSER:  1 signal (5) + streak=2 (10) + 1 day (2) + 1 approved correction (15) = 32
    //
    // STK_LOSER sorts BEFORE STK_WINNER alphabetically ('l' < 'w'), so if the
    // streak tiebreaker works, STK_WINNER must still rank higher.
    const ts = recentTs(3);

    await seed({
      signals: [
        { id: "tb-stk-winner-sig-001", beat_slug: "bitcoin-macro", btc_address: ADDR_TB_STK_WINNER, headline: "STK winner signal", created_at: ts },
        { id: "tb-stk-loser-sig-001",  beat_slug: "bitcoin-macro", btc_address: ADDR_TB_STK_LOSER,  headline: "STK loser base signal", created_at: ts },
        // STK_LOSER files a correction against this signal
        { id: "tb-stk-corrsig-001", beat_slug: "bitcoin-macro", btc_address: ADDR_TB_CORR_SIG, headline: "Correctable signal", created_at: ts },
      ],
      streaks: [
        { btc_address: ADDR_TB_STK_WINNER, current_streak: 5, longest_streak: 5, last_signal_date: ts.slice(0, 10), total_signals: 1 },
        { btc_address: ADDR_TB_STK_LOSER,  current_streak: 2, longest_streak: 2, last_signal_date: ts.slice(0, 10), total_signals: 1 },
      ],
      corrections: [
        { id: "tb-stk-corr-001", signal_id: "tb-stk-corrsig-001", btc_address: ADDR_TB_STK_LOSER, status: "approved", created_at: ts },
      ],
    });

    const leaderboard = await getLeaderboard();
    const entryWinner = findEntry(leaderboard, ADDR_TB_STK_WINNER);
    const entryLoser  = findEntry(leaderboard, ADDR_TB_STK_LOSER);
    expect(entryWinner).toBeDefined();
    expect(entryLoser).toBeDefined();

    // Scores must be equal
    expect(entryWinner!.score).toBe(32);
    expect(entryLoser!.score).toBe(32);

    // Confirm streak values
    expect(entryWinner!.breakdown.currentStreak).toBe(5);
    expect(entryLoser!.breakdown.currentStreak).toBe(2);

    // STK_WINNER (streak=5) must rank before STK_LOSER (streak=2) despite sorting after alphabetically
    const idxWinner = leaderboard.findIndex((e) => e.address === ADDR_TB_STK_WINNER);
    const idxLoser  = leaderboard.findIndex((e) => e.address === ADDR_TB_STK_LOSER);
    expect(idxWinner).toBeLessThan(idxLoser);
  });
});

describe("tiebreak: same score + streak, earlier first signal ranks first", () => {
  it("scout with the oldest first signal outranks the newcomer when score and streak tie", async () => {
    // Both scouts have score=7 (1 signal × 5 + 1 day × 2) and no streak row (streak=0).
    // TEN_WINNER filed their first signal 25 days ago (older tenure).
    // TEN_LOSER  filed their first signal  5 days ago (newer).
    // TEN_LOSER sorts BEFORE TEN_WINNER alphabetically ('l' < 'w'), so tenure tiebreaker must kick in.
    const tsOld = recentTs(25);
    const tsNew = recentTs(5);

    await seed({
      signals: [
        { id: "tb-ten-winner-sig-001", beat_slug: "bitcoin-macro", btc_address: ADDR_TB_TEN_WINNER, headline: "TEN winner signal (older)", created_at: tsOld },
        { id: "tb-ten-loser-sig-001",  beat_slug: "bitcoin-macro", btc_address: ADDR_TB_TEN_LOSER,  headline: "TEN loser signal (newer)", created_at: tsNew },
      ],
    });

    const leaderboard = await getLeaderboard();
    const entryWinner = findEntry(leaderboard, ADDR_TB_TEN_WINNER);
    const entryLoser  = findEntry(leaderboard, ADDR_TB_TEN_LOSER);
    expect(entryWinner).toBeDefined();
    expect(entryLoser).toBeDefined();

    // Equal scores and equal streaks (both 0)
    expect(entryWinner!.score).toBe(entryLoser!.score);
    expect(entryWinner!.breakdown.currentStreak).toBe(0);
    expect(entryLoser!.breakdown.currentStreak).toBe(0);

    // TEN_WINNER (older first signal) must rank before TEN_LOSER (newer) despite sorting after alphabetically
    const idxWinner = leaderboard.findIndex((e) => e.address === ADDR_TB_TEN_WINNER);
    const idxLoser  = leaderboard.findIndex((e) => e.address === ADDR_TB_TEN_LOSER);
    expect(idxWinner).toBeLessThan(idxLoser);
  });
});

describe("tiebreak: same score + streak + tenure → alphabetical btc_address", () => {
  it("when all other tiebreakers are equal, lower address sorts first", async () => {
    // Both scouts: same signal timestamp, no streak row, no other components.
    // score = 1*5 + 1*2 = 7 for each. streak=0. first_signal_at is identical.
    // ALP_A sorts before ALP_B alphabetically ('a' < 'b' in the suffix), so A ranks first.
    const ts = recentTs(7);

    await seed({
      signals: [
        { id: "tb-alp-a-sig-001", beat_slug: "bitcoin-macro", btc_address: ADDR_TB_ALP_A, headline: "Alpha A signal", created_at: ts },
        { id: "tb-alp-b-sig-001", beat_slug: "bitcoin-macro", btc_address: ADDR_TB_ALP_B, headline: "Alpha B signal", created_at: ts },
      ],
    });

    const leaderboard = await getLeaderboard();
    const entryA = findEntry(leaderboard, ADDR_TB_ALP_A);
    const entryB = findEntry(leaderboard, ADDR_TB_ALP_B);
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();

    // Equal scores, streaks, and tenure
    expect(entryA!.score).toBe(entryB!.score);
    expect(entryA!.breakdown.currentStreak).toBe(0);
    expect(entryB!.breakdown.currentStreak).toBe(0);

    // A (alphabetically first) must rank before B
    const idxA = leaderboard.findIndex((e) => e.address === ADDR_TB_ALP_A);
    const idxB = leaderboard.findIndex((e) => e.address === ADDR_TB_ALP_B);
    expect(idxA).toBeLessThan(idxB);
  });
});

describe("combined: all scoring components sum to the correct total", () => {
  it("computes the exact score when all 6 components are populated", async () => {
    const ts = recentTs();
    const ts2 = recentTs(8);
    const ts3 = recentTs(15);

    // Known values for ADDR_ALL:
    // brief_inclusions: 3
    // signal_count: 4 (all with correction_of IS NULL)
    // current_streak: 6 (set via streaks row)
    // days_active: 4 (signals on 4 distinct days: -2d, -5d, -8d, -15d)
    // approved_corrections: 2
    // referral_credits: 2

    const signalId1 = "all-sig-001";
    const signalId2 = "all-sig-002";
    const signalId3 = "all-sig-003";
    const signalId4 = "all-sig-004";

    await seed({
      signals: [
        { id: signalId1, beat_slug: "bitcoin-macro", btc_address: ADDR_ALL, headline: "All component signal 1", created_at: ts },
        { id: signalId2, beat_slug: "bitcoin-macro", btc_address: ADDR_ALL, headline: "All component signal 2", created_at: ts2 },
        { id: signalId3, beat_slug: "bitcoin-macro", btc_address: ADDR_ALL, headline: "All component signal 3", created_at: ts3 },
        { id: signalId4, beat_slug: "bitcoin-macro", btc_address: ADDR_ALL, headline: "All component signal 4", created_at: recentTs(2) },
        // Signal owned by ADDR_ALL_SIG for corrections to reference
        { id: "all-corrsig-001", beat_slug: "bitcoin-macro", btc_address: ADDR_ALL_SIG, headline: "Signal for correction", created_at: ts },
      ],
      brief_signals: [
        { brief_date: "2026-03-10", signal_id: signalId1, btc_address: ADDR_ALL, created_at: ts },
        { brief_date: "2026-03-11", signal_id: signalId2, btc_address: ADDR_ALL, created_at: ts2 },
        { brief_date: "2026-03-12", signal_id: signalId3, btc_address: ADDR_ALL, created_at: ts3 },
      ],
      corrections: [
        { id: "all-corr-001", signal_id: "all-corrsig-001", btc_address: ADDR_ALL, status: "approved", created_at: ts },
        { id: "all-corr-002", signal_id: "all-corrsig-001", btc_address: ADDR_ALL, status: "approved", created_at: ts2 },
      ],
      referral_credits: [
        { id: "all-ref-001", scout_address: ADDR_ALL, recruit_address: ADDR_ALL_REC + "1", credited_at: ts, created_at: ts },
        { id: "all-ref-002", scout_address: ADDR_ALL, recruit_address: ADDR_ALL_REC + "2", credited_at: ts2, created_at: ts2 },
      ],
      streaks: [
        { btc_address: ADDR_ALL, current_streak: 6, longest_streak: 10, last_signal_date: ts.slice(0, 10), total_signals: 4 },
      ],
    });

    const leaderboard = await getLeaderboard();
    const entry = findEntry(leaderboard, ADDR_ALL);
    expect(entry).toBeDefined();

    // Verify each component
    expect(entry!.breakdown.briefInclusions).toBe(3);
    expect(entry!.breakdown.signalCount).toBe(4);
    expect(entry!.breakdown.currentStreak).toBe(6);
    expect(entry!.breakdown.daysActive).toBe(4);
    expect(entry!.breakdown.approvedCorrections).toBe(2);
    expect(entry!.breakdown.referralCredits).toBe(2);

    // Compute expected total using SCORING_WEIGHTS
    const expectedScore =
      3 * SCORING_WEIGHTS.brief_inclusions +
      4 * SCORING_WEIGHTS.signal_count +
      6 * SCORING_WEIGHTS.current_streak +
      4 * SCORING_WEIGHTS.days_active +
      2 * SCORING_WEIGHTS.approved_corrections +
      2 * SCORING_WEIGHTS.referral_credits;

    // = 3*20 + 4*5 + 6*5 + 4*2 + 2*15 + 2*25
    // = 60  + 20  + 30  + 8   + 30   + 50
    // = 198
    expect(entry!.score).toBe(expectedScore);
    expect(expectedScore).toBe(198);
  });
});

// ── Reset epoch tests ─────────────────────────────────────────────────────────
// These MUST run last because seeding a launch_reset snapshot sets the scoring
// epoch for all subsequent queries in this shared DO instance.

describe("reset epoch: signals before reset are excluded from scoring", () => {
  it("pre-reset signals produce score=0; post-reset signals score normally", async () => {
    // Timeline:
    //   10 days ago: ADDR_RESET_PRE files a signal (before the reset)
    //    8 days ago: launch_reset snapshot created (the scoring epoch)
    //    3 days ago: ADDR_RESET_POST files a signal (after the reset)
    const preResetTs = recentTs(10);
    const resetTs = recentTs(8);
    const postResetTs = recentTs(3);

    await seed({
      signals: [
        // Pre-reset signal — should be excluded from scoring
        { id: "reset-pre-sig-001", beat_slug: "bitcoin-macro", btc_address: ADDR_RESET_PRE, headline: "Pre-reset signal", created_at: preResetTs },
        // Post-reset signal — should be counted
        { id: "reset-post-sig-001", beat_slug: "bitcoin-macro", btc_address: ADDR_RESET_POST, headline: "Post-reset signal", created_at: postResetTs },
      ],
      leaderboard_snapshots: [
        { id: "reset-snapshot-001", snapshot_type: "launch_reset", snapshot_data: "[]", created_at: resetTs },
      ],
    });

    const leaderboard = await getLeaderboard();

    // Pre-reset scout should not appear on the leaderboard at all
    const preEntry = findEntry(leaderboard, ADDR_RESET_PRE);
    expect(preEntry).toBeUndefined();

    // Post-reset scout should appear with normal scoring
    const postEntry = findEntry(leaderboard, ADDR_RESET_POST);
    expect(postEntry).toBeDefined();
    expect(postEntry!.breakdown.signalCount).toBe(1);
    expect(postEntry!.breakdown.daysActive).toBe(1);
    const expectedScore =
      1 * SCORING_WEIGHTS.signal_count +
      1 * SCORING_WEIGHTS.days_active;
    expect(postEntry!.score).toBe(expectedScore);
  });
});
