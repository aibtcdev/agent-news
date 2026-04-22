/**
 * Signal provenance — look up the daily brief a signal was included in
 * so we can surface Bitcoin inscription proof on the signal's article page.
 *
 * A signal is considered "inscribed" when:
 *   1. Its status is `brief_included`
 *   2. The brief for its UTC day exists
 *   3. That brief has a non-null `inscription_id`
 *
 * Any of those missing → returns null. Callers should treat null as
 * "no on-chain provenance to display yet".
 */

import type { Env, Signal } from "./types";
import { getUTCDate } from "./helpers";
import { getBriefByDate } from "./do-client";

export interface SignalProvenance {
  /** UTC calendar date (YYYY-MM-DD) of the brief this signal was included in. */
  briefDate: string;
  /** Ordinal inscription ID — the immutable on-chain record of the brief. */
  inscriptionId: string;
  /** Reveal transaction ID on Bitcoin (null if we only have the inscription_id). */
  inscribedTxid: string | null;
  /** Ordinals viewer URL for the inscription — the human-facing "archivedAt" target. */
  inscriptionUrl: string;
  /** mempool.space tx URL (null if we don't have a txid). */
  txUrl: string | null;
}

/** Returns null when the signal has no on-chain brief yet. */
export async function getSignalProvenance(
  env: Env,
  signal: Signal
): Promise<SignalProvenance | null> {
  if (signal.status !== "brief_included") return null;

  const briefDate = getUTCDate(new Date(signal.created_at));
  const brief = await getBriefByDate(env, briefDate).catch(() => null);
  if (!brief?.inscription_id) return null;

  return {
    briefDate: brief.date,
    inscriptionId: brief.inscription_id,
    inscribedTxid: brief.inscribed_txid,
    inscriptionUrl: `https://ordinals.com/inscription/${brief.inscription_id}`,
    txUrl: brief.inscribed_txid
      ? `https://mempool.space/tx/${brief.inscribed_txid}`
      : null,
  };
}
