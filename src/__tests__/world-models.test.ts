import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

async function seed(body: Record<string, unknown>) {
  const res = await SELF.fetch("http://example.com/api/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

describe("Company World Model endpoints", () => {
  it("returns beat health, correspondent stats, and editor performance from platform artifacts", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const beat = `wm-beat-${suffix}`;
    const correspondent = `bc1q-wm-correspondent-${suffix}`;
    const editor = `bc1q-wm-editor-${suffix}`;
    const publisher = `bc1q-wm-publisher-${suffix}`;

    await seed({
      beats: [
        {
          slug: beat,
          name: "World Model Test Beat",
          created_by: publisher,
          created_at: hoursAgo(48),
          updated_at: hoursAgo(1),
          status: "active",
          editor_review_rate_sats: 500,
        },
      ],
      beat_editors: [
        {
          beat_slug: beat,
          btc_address: editor,
          status: "active",
          registered_at: hoursAgo(24),
          registered_by: publisher,
        },
      ],
      signals: [
        {
          id: `wm-submitted-${suffix}`,
          beat_slug: beat,
          btc_address: correspondent,
          headline: "Submitted signal",
          sources: "[]",
          created_at: hoursAgo(5),
          status: "submitted",
          quality_score: 70,
        },
        {
          id: `wm-approved-${suffix}`,
          beat_slug: beat,
          btc_address: correspondent,
          headline: "Approved signal",
          sources: "[]",
          created_at: hoursAgo(8),
          status: "approved",
          reviewed_at: hoursAgo(2),
          quality_score: 90,
        },
        {
          id: `wm-rejected-${suffix}`,
          beat_slug: beat,
          btc_address: correspondent,
          headline: "Rejected signal",
          sources: "[]",
          created_at: hoursAgo(7),
          status: "rejected",
          reviewed_at: hoursAgo(1),
          quality_score: 60,
        },
        {
          id: `wm-brief-${suffix}`,
          beat_slug: beat,
          btc_address: correspondent,
          headline: "Brief included signal",
          sources: "[]",
          created_at: hoursAgo(6),
          status: "brief_included",
          reviewed_at: hoursAgo(1),
          quality_score: 80,
        },
      ],
      corrections: [
        {
          id: `wm-review-pending-${suffix}`,
          signal_id: `wm-submitted-${suffix}`,
          btc_address: editor,
          status: "pending",
          type: "editorial_review",
          claim: "editorial_review",
          correction: "Needs publisher decision",
          score: 70,
          factcheck_passed: true,
          beat_relevance: 90,
          recommendation: "approve",
          created_at: hoursAgo(1),
        },
        {
          id: `wm-review-pass-${suffix}`,
          signal_id: `wm-approved-${suffix}`,
          btc_address: editor,
          status: "approved",
          type: "editorial_review",
          claim: "editorial_review",
          correction: "Good signal",
          score: 92,
          factcheck_passed: true,
          beat_relevance: 95,
          recommendation: "approve",
          created_at: hoursAgo(1),
          reviewed_by: publisher,
          reviewed_at: hoursAgo(1),
        },
        {
          id: `wm-review-fail-${suffix}`,
          signal_id: `wm-rejected-${suffix}`,
          btc_address: editor,
          status: "rejected",
          type: "editorial_review",
          claim: "editorial_review",
          correction: "Missed a factual issue",
          score: 40,
          factcheck_passed: false,
          beat_relevance: 80,
          recommendation: "approve",
          created_at: hoursAgo(1),
          reviewed_by: publisher,
          reviewed_at: hoursAgo(1),
        },
        {
          id: `wm-correction-${suffix}`,
          signal_id: `wm-approved-${suffix}`,
          btc_address: correspondent,
          status: "approved",
          type: "correction",
          claim: "Incorrect number",
          correction: "Corrected number",
          created_at: hoursAgo(1),
          reviewed_by: publisher,
          reviewed_at: hoursAgo(1),
        },
      ],
      streaks: [
        {
          btc_address: correspondent,
          current_streak: 3,
          longest_streak: 5,
          last_signal_date: hoursAgo(5).slice(0, 10),
          total_signals: 4,
        },
      ],
      earnings: [
        {
          id: `wm-paid-${suffix}`,
          btc_address: correspondent,
          amount_sats: 1200,
          reason: "brief_inclusion",
          reference_id: `wm-brief-${suffix}`,
          created_at: hoursAgo(1),
          payout_txid: `tx-paid-${suffix}`,
        },
        {
          id: `wm-unpaid-${suffix}`,
          btc_address: correspondent,
          amount_sats: 300,
          reason: "brief_inclusion",
          reference_id: `wm-approved-${suffix}`,
          created_at: hoursAgo(1),
          payout_txid: null,
        },
        {
          id: `wm-editor-unpaid-${suffix}`,
          btc_address: editor,
          amount_sats: 500,
          reason: "editor_review",
          reference_id: `wm-approved-${suffix}`,
          created_at: hoursAgo(1),
          payout_txid: null,
        },
      ],
    });

    const beatRes = await SELF.fetch(`http://example.com/api/beats/${beat}/health`);
    expect(beatRes.status).toBe(200);
    const beatBody = await beatRes.json<{
      beat: string;
      submitted: number;
      in_review: number;
      queue_depth: number;
      approved_24h: number;
      rejected_24h: number;
      editor: { btc_address: string; status: string; last_review: string | null };
      spot_check_pass_rate_30d: number | null;
      health_score: number;
    }>();
    expect(beatBody.beat).toBe(beat);
    expect(beatBody.submitted).toBe(1);
    expect(beatBody.in_review).toBe(1);
    expect(beatBody.queue_depth).toBe(2);
    expect(beatBody.approved_24h).toBe(1);
    expect(beatBody.rejected_24h).toBe(1);
    expect(beatBody.editor.btc_address).toBe(editor);
    expect(beatBody.editor.status).toBe("active");
    expect(beatBody.editor.last_review).not.toBeNull();
    expect(beatBody.spot_check_pass_rate_30d).toBe(0.5);
    expect(beatBody.health_score).toBeGreaterThanOrEqual(0);

    const allBeatsRes = await SELF.fetch("http://example.com/api/beats/health");
    expect(allBeatsRes.status).toBe(200);
    const allBeatsBody = await allBeatsRes.json<{ beats: Array<{ beat: string }> }>();
    expect(allBeatsBody.beats.some((row) => row.beat === beat)).toBe(true);

    const correspondentRes = await SELF.fetch(
      `http://example.com/api/correspondents/${encodeURIComponent(correspondent)}/stats`
    );
    expect(correspondentRes.status).toBe(200);
    const correspondentBody = await correspondentRes.json<{
      btc_address: string;
      signals_total: number;
      by_status: { submitted: number; approved: number; rejected: number; brief_included: number };
      approval_rate: number | null;
      avg_score: number | null;
      factual_errors_caught: number;
      beats_active: string[];
      streaks: { current: number; longest: number; days_active: number };
      earnings: { total_earned_sats: number; unpaid_sats: number };
      recent_activity: { signals_7d: number; signals_30d: number };
    }>();
    expect(correspondentBody.btc_address).toBe(correspondent);
    expect(correspondentBody.signals_total).toBe(4);
    expect(correspondentBody.by_status.submitted).toBe(1);
    expect(correspondentBody.by_status.approved).toBe(1);
    expect(correspondentBody.by_status.rejected).toBe(1);
    expect(correspondentBody.by_status.brief_included).toBe(1);
    expect(correspondentBody.approval_rate).toBe(0.67);
    expect(correspondentBody.avg_score).toBe(75);
    expect(correspondentBody.factual_errors_caught).toBe(1);
    expect(correspondentBody.beats_active).toContain(beat);
    expect(correspondentBody.streaks.current).toBe(3);
    expect(correspondentBody.streaks.longest).toBe(5);
    expect(correspondentBody.earnings.total_earned_sats).toBe(1200);
    expect(correspondentBody.earnings.unpaid_sats).toBe(300);
    expect(correspondentBody.recent_activity.signals_7d).toBe(4);

    const allStatsRes = await SELF.fetch("http://example.com/api/correspondents/stats");
    expect(allStatsRes.status).toBe(200);
    const allStatsBody = await allStatsRes.json<{ correspondents: Array<{ btc_address: string }> }>();
    expect(allStatsBody.correspondents.some((row) => row.btc_address === correspondent)).toBe(true);

    const editorRes = await SELF.fetch(
      `http://example.com/api/editors/${encodeURIComponent(editor)}/performance`
    );
    expect(editorRes.status).toBe(200);
    const editorBody = await editorRes.json<{
      btc_address: string;
      beat: string | null;
      beats: string[];
      signals_reviewed: number;
      signals_reviewed_7d: number;
      spot_checks_received: number;
      spot_check_failures: number;
      spot_check_pass_rate: number | null;
      correspondents_reviewed: number;
      status: string;
      role_health: string;
      earnings: { unpaid_sats: number };
    }>();
    expect(editorBody.btc_address).toBe(editor);
    expect(editorBody.beat).toBe(beat);
    expect(editorBody.beats).toContain(beat);
    expect(editorBody.signals_reviewed).toBe(3);
    expect(editorBody.signals_reviewed_7d).toBe(3);
    expect(editorBody.spot_checks_received).toBe(2);
    expect(editorBody.spot_check_failures).toBe(1);
    expect(editorBody.spot_check_pass_rate).toBe(0.5);
    expect(editorBody.correspondents_reviewed).toBe(1);
    expect(editorBody.status).toBe("active");
    expect(editorBody.role_health).toBe("needs_coaching");
    expect(editorBody.earnings.unpaid_sats).toBe(500);

    const leaderboardRes = await SELF.fetch("http://example.com/api/editors/leaderboard");
    expect(leaderboardRes.status).toBe(200);
    const leaderboardBody = await leaderboardRes.json<{ editors: Array<{ btc_address: string }> }>();
    expect(leaderboardBody.editors.some((row) => row.btc_address === editor)).toBe(true);
  });
});
