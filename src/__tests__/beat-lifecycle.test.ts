import { describe, expect, it } from "vitest";
import { BeatGracePeriodSuccessSchema } from "@aibtc/tx-schemas/news";
import {
  buildGraceTransition,
  deriveBeatLifecycleFlags,
  getDefaultBeatDailyApprovedLimit,
  getDefaultBeatLifecycle,
  getDefaultReplacementBeats,
  parseReplacementBeats,
} from "../lib/beat-lifecycle";

describe("beat lifecycle helpers", () => {
  it("marks the 3 launch beats as active with a 10-signal daily cap", () => {
    expect(getDefaultBeatLifecycle("aibtc-network")).toBe("active");
    expect(getDefaultBeatLifecycle("bitcoin-macro")).toBe("active");
    expect(getDefaultBeatLifecycle("quantum")).toBe("active");
    expect(getDefaultBeatDailyApprovedLimit("aibtc-network")).toBe(10);
    expect(getDefaultBeatDailyApprovedLimit("onboarding")).toBeNull();
  });

  it("derives consistent flags for active, grace, and retired beats", () => {
    expect(deriveBeatLifecycleFlags("active")).toEqual({
      lifecycle: "active",
      is_fileable: true,
      is_listed_active: true,
      is_assignable_editor: true,
      archive_only: false,
    });
    expect(deriveBeatLifecycleFlags("grace")).toEqual({
      lifecycle: "grace",
      is_fileable: true,
      is_listed_active: false,
      is_assignable_editor: false,
      archive_only: false,
    });
    expect(deriveBeatLifecycleFlags("retired")).toEqual({
      lifecycle: "retired",
      is_fileable: false,
      is_listed_active: false,
      is_assignable_editor: false,
      archive_only: true,
    });
  });

  it("parses replacement beats and falls back to the active trio", () => {
    expect(parseReplacementBeats('["aibtc-network","quantum"]', "legacy")).toEqual([
      "aibtc-network",
      "quantum",
    ]);
    expect(getDefaultReplacementBeats("legacy")).toEqual([
      "aibtc-network",
      "bitcoin-macro",
      "quantum",
    ]);
    expect(parseReplacementBeats(null, "legacy")).toEqual([
      "aibtc-network",
      "bitcoin-macro",
      "quantum",
    ]);
  });

  it("builds machine-readable grace transition guidance", () => {
    const transition = buildGraceTransition({
      slug: "legacy",
      lifecycle: "grace",
      replacement_beats: ["aibtc-network", "bitcoin-macro", "quantum"],
      transition_started_at: "2026-04-08T00:00:00.000Z",
      transition_effective_at: "2026-04-09T00:00:00.000Z",
      transition_docs_url: "https://aibtc.news/about/#beat-lifecycle",
      transition_message: "Refile future work under an active beat.",
    });

    expect(transition).toEqual({
      code: "beat_transition_grace",
      beat_lifecycle: "grace",
      replacement_beats: ["aibtc-network", "bitcoin-macro", "quantum"],
      transition_started_at: "2026-04-08T00:00:00.000Z",
      transition_effective_at: "2026-04-09T00:00:00.000Z",
      docs_url: "https://aibtc.news/about/#beat-lifecycle",
      message_for_agent: "Refile future work under an active beat.",
    });
    expect(BeatGracePeriodSuccessSchema.safeParse(transition).success).toBe(true);
  });
});
