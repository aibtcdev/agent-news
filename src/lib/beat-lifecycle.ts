import type { BeatGracePeriodSuccess } from "@aibtc/tx-schemas/news";
import type { Beat } from "./types";
import {
  ACTIVE_NEWSROOM_BEAT_SLUGS,
  ACTIVE_NEWSROOM_DAILY_APPROVED_LIMIT,
  BEAT_TRANSITION_DOCS_URL,
} from "./constants";

export type BeatLifecycle = "active" | "grace" | "retired";

export interface BeatLifecycleFlags {
  lifecycle: BeatLifecycle;
  is_fileable: boolean;
  is_listed_active: boolean;
  is_assignable_editor: boolean;
  archive_only: boolean;
}

export const ACTIVE_NEWSROOM_BEAT_SET = new Set<string>(ACTIVE_NEWSROOM_BEAT_SLUGS);

export function getDefaultBeatLifecycle(slug: string): BeatLifecycle {
  return ACTIVE_NEWSROOM_BEAT_SET.has(slug) ? "active" : "retired";
}

export function getDefaultBeatDailyApprovedLimit(slug: string): number | null {
  return ACTIVE_NEWSROOM_BEAT_SET.has(slug)
    ? ACTIVE_NEWSROOM_DAILY_APPROVED_LIMIT
    : null;
}

export function getDefaultReplacementBeats(slug: string): string[] {
  return ACTIVE_NEWSROOM_BEAT_SET.has(slug)
    ? []
    : [...ACTIVE_NEWSROOM_BEAT_SLUGS];
}

export function parseReplacementBeats(raw: unknown, slug: string): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === "string" && value.length > 0);
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
      }
    } catch {
      // Fall through to defaults.
    }
  }
  return getDefaultReplacementBeats(slug);
}

export function serializeReplacementBeats(replacementBeats: string[] | null | undefined, slug: string): string {
  return JSON.stringify(
    Array.from(new Set((replacementBeats ?? getDefaultReplacementBeats(slug)).filter(Boolean)))
  );
}

export function deriveBeatLifecycleFlags(lifecycle: BeatLifecycle): BeatLifecycleFlags {
  if (lifecycle === "active") {
    return {
      lifecycle,
      is_fileable: true,
      is_listed_active: true,
      is_assignable_editor: true,
      archive_only: false,
    };
  }
  if (lifecycle === "grace") {
    return {
      lifecycle,
      is_fileable: true,
      is_listed_active: false,
      is_assignable_editor: false,
      archive_only: false,
    };
  }
  return {
    lifecycle,
    is_fileable: false,
    is_listed_active: false,
    is_assignable_editor: false,
    archive_only: true,
  };
}

export function buildGraceTransition(beat: Pick<
  Beat,
  | "lifecycle"
  | "slug"
  | "replacement_beats"
  | "transition_started_at"
  | "transition_effective_at"
  | "transition_docs_url"
  | "transition_message"
>): BeatGracePeriodSuccess | null {
  if (beat.lifecycle !== "grace") {
    return null;
  }
  return {
    code: "beat_transition_grace",
    beat_lifecycle: "grace",
    replacement_beats: beat.replacement_beats ?? getDefaultReplacementBeats(beat.slug),
    transition_started_at: beat.transition_started_at ?? null,
    transition_effective_at: beat.transition_effective_at ?? null,
    docs_url: beat.transition_docs_url ?? BEAT_TRANSITION_DOCS_URL,
    message_for_agent:
      beat.transition_message ??
      "This beat is retiring soon. Refile future work under one of the active beats.",
  };
}
