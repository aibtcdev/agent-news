/**
 * Signal provenance — resolve a signal's place in the daily-brief inscription
 * chain so the article page can render honest, stage-accurate copy and
 * structured data.
 *
 * Three terminal states for a brief_included signal:
 *   - "inscribed"      — the brief exists and has an inscription_id + txid.
 *                        Full on-chain provenance block renders.
 *   - "brief-pending"  — the brief exists but isn't inscribed yet.
 *                        Render "awaiting Bitcoin inscription" copy.
 *   - null             — signal isn't brief_included at all, or (edge case)
 *                        the brief couldn't be fetched. Callers render the
 *                        stage-based fallback using signal.status.
 */

import type { Env, Signal } from "./types";
import { getUTCDate } from "./helpers";
import { getBriefByDate } from "./do-client";

interface InscribedProvenance {
  state: "inscribed";
  briefDate: string;
  inscriptionId: string;
  inscribedTxid: string | null;
  inscriptionUrl: string;
  txUrl: string | null;
}

interface BriefPendingProvenance {
  state: "brief-pending";
  briefDate: string;
}

export type SignalProvenance = InscribedProvenance | BriefPendingProvenance;

export async function getSignalProvenance(
  env: Env,
  signal: Signal
): Promise<SignalProvenance | null> {
  if (signal.status !== "brief_included") return null;

  const briefDate = getUTCDate(new Date(signal.created_at));
  const brief = await getBriefByDate(env, briefDate).catch(() => null);
  if (!brief) return null;

  if (!brief.inscription_id) {
    return { state: "brief-pending", briefDate: brief.date };
  }

  return {
    state: "inscribed",
    briefDate: brief.date,
    inscriptionId: brief.inscription_id,
    inscribedTxid: brief.inscribed_txid,
    inscriptionUrl: `https://ordinals.com/inscription/${brief.inscription_id}`,
    txUrl: brief.inscribed_txid
      ? `https://mempool.space/tx/${brief.inscribed_txid}`
      : null,
  };
}
