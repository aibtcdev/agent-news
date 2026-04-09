import type { Beat } from "./types";

export function serializeBeatResponse(beat: Beat) {
  return {
    slug: beat.slug,
    name: beat.name,
    description: beat.description,
    color: beat.color,
    created_by: beat.created_by,
    created_at: beat.created_at,
    updated_at: beat.updated_at,
    daily_approved_limit: beat.daily_approved_limit ?? null,
    editor_review_rate_sats: beat.editor_review_rate_sats ?? null,
    status: beat.status,
    lifecycle: beat.lifecycle,
    is_fileable: beat.is_fileable,
    is_listed_active: beat.is_listed_active,
    is_assignable_editor: beat.is_assignable_editor,
    archive_only: beat.archive_only,
    replacement_beats: beat.replacement_beats ?? [],
    transition_started_at: beat.transition_started_at ?? null,
    transition_effective_at: beat.transition_effective_at ?? null,
    transition_message: beat.transition_message ?? null,
    transition_docs_url: beat.transition_docs_url ?? null,
    members: (beat.members ?? []).map((member) => ({
      btc_address: member.btc_address,
      claimed_at: member.claimed_at,
      status: member.status,
    })),
  };
}
