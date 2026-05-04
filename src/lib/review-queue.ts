import type { Env, Signal } from "./types";
import { listSignals } from "./do-client";

const REVIEW_VELOCITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const REVIEW_VELOCITY_CACHE_TTL_MS = 5 * 60 * 1000;
// Queue position is approximate if a beat has more pending signals than this cap.
// Keep it high enough for competition-week backlogs while avoiding unbounded DO reads.
const REVIEW_LOOKBACK_LIMIT = 500;

interface ReviewVelocityCacheEntry {
  readonly expiresAt: number;
  readonly reviewedInWindow: number;
}

const reviewVelocityCache = new Map<string, ReviewVelocityCacheEntry>();

export interface QueueMetadata {
  queue_position: number | null;
  estimated_review_time: string | null;
}

type QueueSignal = Pick<Signal, "id" | "beat_slug" | "created_at" | "status" | "correction_of">;

function estimateReviewTime(queuePosition: number, reviewedInWindow: number): string | null {
  if (queuePosition === 0) return "next";
  if (reviewedInWindow <= 0) return null;

  const hourlyVelocity = reviewedInWindow / 24;
  const estimatedHours = Math.ceil((queuePosition + 1) / hourlyVelocity);
  if (estimatedHours <= 1) return "~1 hour";
  if (estimatedHours < 24) return `~${estimatedHours} hours`;

  const estimatedDays = Math.ceil(estimatedHours / 24);
  return estimatedDays === 1 ? "~1 day" : `~${estimatedDays} days`;
}

async function getReviewedVelocity(env: Env, beat: string, since: string): Promise<number> {
  const cacheKey = `${beat}:${since}`;
  const cached = reviewVelocityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.reviewedInWindow;

  const [approvedRecent, rejectedRecent] = await Promise.all([
    listSignals(env, { beat, status: "approved", since, limit: REVIEW_LOOKBACK_LIMIT }),
    listSignals(env, { beat, status: "rejected", since, limit: REVIEW_LOOKBACK_LIMIT }),
  ]);
  const reviewedInWindow = approvedRecent.length + rejectedRecent.length;
  reviewVelocityCache.set(cacheKey, {
    expiresAt: Date.now() + REVIEW_VELOCITY_CACHE_TTL_MS,
    reviewedInWindow,
  });
  return reviewedInWindow;
}

export async function buildQueueMetadata(
  env: Env,
  signals: QueueSignal[]
): Promise<Map<string, QueueMetadata>> {
  const metadata = new Map<string, QueueMetadata>();
  const submittedSignals = signals.filter(
    (signal) => signal.status === "submitted" && signal.correction_of === null
  );

  for (const signal of signals) {
    metadata.set(signal.id, { queue_position: null, estimated_review_time: null });
  }

  if (submittedSignals.length === 0) return metadata;

  const beatSlugs = [...new Set(submittedSignals.map((signal) => signal.beat_slug))];
  const since = new Date(Date.now() - REVIEW_VELOCITY_WINDOW_MS).toISOString();

  await Promise.all(
    beatSlugs.map(async (beat) => {
      const [submittedQueue, reviewedInWindow] = await Promise.all([
        listSignals(env, { beat, status: "submitted", limit: REVIEW_LOOKBACK_LIMIT }),
        getReviewedVelocity(env, beat, since),
      ]);

      const queue = submittedQueue
        .filter((signal) => signal.correction_of === null)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));

      for (const signal of submittedSignals.filter((item) => item.beat_slug === beat)) {
        const queuePosition = queue.filter((queued) => queued.created_at < signal.created_at).length;
        metadata.set(signal.id, {
          queue_position: queuePosition,
          estimated_review_time: estimateReviewTime(queuePosition, reviewedInWindow),
        });
      }
    })
  );

  return metadata;
}
