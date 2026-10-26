/**
 * Read-only chain access for the Legion (v2).
 *
 * This is the half of the pipeline chainhooks structurally cannot cover. A week
 * moves voting → veto → concludable purely because the tip passed `voteEnd` and
 * `voteEnd + vetoWindow`, with no transaction and therefore no event to push. A
 * webhook-only page would sit on "voting" long after voting closed.
 *
 * v2 exposes `get-phase` and `get-params`, so both the phase and the governance
 * thresholds are now read from the contract rather than recomputed here. The
 * tip is still fetched, but only to render a countdown — never to decide a
 * phase, which keeps this module from disagreeing with the contract.
 *
 * Everything here is a plain HTTP read against the Hiro API — no signing, no
 * keys.
 */

import {
  HIRO_API_BASE,
  LEGION_GOV_CONTRACT,
  LEGION_TREASURY_CONTRACT,
  LEGION_DEPLOYER,
  type BriefReason,
  type LegionPhase,
  type PredictedOutcome,
} from "../lib/legion-constants";
import {
  decodeClarityHex,
  unwrapOptional,
  unwrapResponse,
  asNumber,
  tupleField,
  type ClarityValue,
} from "../lib/clarity";

const FETCH_TIMEOUT_MS = 8_000;

export interface ChainReadOptions {
  fetchImpl?: typeof fetch;
  /** Hiro API key, lifts the anonymous rate limit. Optional. */
  apiKey?: string;
}

async function hiroFetch(
  path: string,
  init: RequestInit,
  opts: ChainReadOptions
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = new Headers(init.headers);
  if (opts.apiKey) headers.set("x-api-key", opts.apiKey);

  // AbortSignal.timeout keeps a hung upstream from pinning the cron invocation.
  const res = await doFetch(`${HIRO_API_BASE}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Hiro ${path} returned ${res.status}`);
  }
  return res;
}

/** Serialise a `string-ascii` argument: type byte, u32 length, then the bytes. */
export function encodeStringAscii(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const len = bytes.length.toString(16).padStart(8, "0");
  let body = "";
  for (const b of bytes) body += b.toString(16).padStart(2, "0");
  return `0x0d${len}${body}`;
}

/**
 * Invoke a read-only function and decode the result.
 *
 * `sender` is required by the node but has no effect on any Legion read — none
 * of them branch on tx-sender — so the deployer address is used as a constant.
 */
export async function callReadOnly(
  contract: string,
  functionName: string,
  functionArgs: string[] = [],
  opts: ChainReadOptions = {}
): Promise<ClarityValue> {
  const [address, name] = contract.split(".");
  const res = await hiroFetch(
    `/v2/contracts/call-read/${address}/${name}/${functionName}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: LEGION_DEPLOYER, arguments: functionArgs }),
    },
    opts
  );

  const body = (await res.json()) as { okay: boolean; result?: string; cause?: string };
  if (!body.okay || !body.result) {
    throw new Error(`${contract}.${functionName} failed: ${body.cause ?? "unknown cause"}`);
  }
  return unwrapResponse(decodeClarityHex(body.result));
}

/** Current Stacks tip height. */
export async function getTipHeight(opts: ChainReadOptions = {}): Promise<number> {
  const res = await hiroFetch("/v2/info", { method: "GET" }, opts);
  const body = (await res.json()) as { stacks_tip_height?: number };
  if (typeof body.stacks_tip_height !== "number") {
    throw new Error("Hiro /v2/info returned no stacks_tip_height");
  }
  return body.stacks_tip_height;
}

export interface BriefRecord {
  briefDate: string;
  status: number;
  reason: BriefReason;
  /** Payout fixed at propose time. v2 snapshots this so a late conclude pays the same. */
  draw: number;
  voteEnd: number;
  createdAt: number;
  yesWeight: number;
  noWeight: number;
  vetoWeight: number;
  voterCount: number;
  entryCount: number;
  totalSignals: number;
  bond: number;
  eligibleSnapshot: number;
}

/** Fetch one week's on-chain record, or null if never proposed. */
export async function getBrief(
  briefDate: string,
  opts: ChainReadOptions = {}
): Promise<BriefRecord | null> {
  const raw = await callReadOnly(
    LEGION_GOV_CONTRACT,
    "get-brief",
    [encodeStringAscii(briefDate)],
    opts
  );
  const brief = unwrapOptional(raw);
  if (!brief || brief.type !== "tuple") return null;

  const reason = tupleField(brief, "reason");
  return {
    briefDate,
    status: asNumber(tupleField(brief, "status")),
    reason: (reason?.type === "string" ? reason.value : "") as BriefReason,
    draw: asNumber(tupleField(brief, "draw")),
    voteEnd: asNumber(tupleField(brief, "voteEnd")),
    createdAt: asNumber(tupleField(brief, "createdAt")),
    yesWeight: asNumber(tupleField(brief, "yesWeight")),
    noWeight: asNumber(tupleField(brief, "noWeight")),
    vetoWeight: asNumber(tupleField(brief, "vetoWeight")),
    voterCount: asNumber(tupleField(brief, "voterCount")),
    entryCount: asNumber(tupleField(brief, "entryCount")),
    totalSignals: asNumber(tupleField(brief, "totalSignals")),
    bond: asNumber(tupleField(brief, "bond")),
    eligibleSnapshot: asNumber(tupleField(brief, "eligibleSnapshot")),
  };
}

/** Brief title/description. Separate call because it lives on a separate getter. */
export async function getBriefMeta(
  briefDate: string,
  opts: ChainReadOptions = {}
): Promise<{ title: string; description: string } | null> {
  const raw = await callReadOnly(
    LEGION_GOV_CONTRACT,
    "get-brief-meta",
    [encodeStringAscii(briefDate)],
    opts
  );
  const meta = unwrapOptional(raw);
  if (!meta || meta.type !== "tuple") return null;

  const title = tupleField(meta, "title");
  const description = tupleField(meta, "description");
  return {
    title: title?.type === "string" ? title.value : "",
    description: description?.type === "string" ? description.value : "",
  };
}

/**
 * Lifecycle phase, derived locally from the tip.
 *
 * The contract exposes `get-phase`, but calling it would be a Hiro read on
 * every page load for something that is pure arithmetic on values we already
 * hold: the brief's `status` and `voteEnd` (both in the brief record) against
 * the current tip and the window sizes (from params). This mirrors the
 * contract's `get-phase` branch-for-branch, so it cannot drift — the same
 * inputs produce the same answer, without the round trip.
 */
export function deriveLegionPhase(
  brief: Pick<BriefRecord, "status" | "voteEnd"> | null,
  tipHeight: number,
  vetoWindow: number,
  concludeWindow: number
): LegionPhase {
  if (!brief) return "none";
  if (brief.status === 1) return "passed"; // BRIEF_STATUS.PASSED
  if (brief.status === 2) return "failed"; // BRIEF_STATUS.FAILED

  const vetoEnd = brief.voteEnd + vetoWindow;
  const concludeEnd = vetoEnd + concludeWindow;
  if (tipHeight < brief.voteEnd) return "voting";
  if (tipHeight < vetoEnd) return "veto";
  if (tipHeight < concludeEnd) return "concludable";
  return "lapsed";
}

export interface LegionParams {
  votingQuorum: number;
  votingThreshold: number;
  vetoQuorum: number;
  minParticipants: number;
  minWeight: number;
  drawBps: number;
  bondBps: number;
  minBond: number;
  voteWindow: number;
  vetoWindow: number;
  concludeWindow: number;
  proposeInterval: number;
}

/**
 * Governance parameters, read from the contract.
 *
 * v2 added `get-params` specifically so a UI stops hardcoding thresholds that
 * drift from the deployed code. Everything downstream takes these as input
 * rather than importing constants.
 */
/**
 * Governance parameters are immutable for a given contract, so the first read
 * in a Worker isolate is cached in memory for the isolate's life. This is a
 * free cache — no storage, no billing — and it means the common page load pays
 * zero Hiro calls for parameters. Keyed by contract so a redeploy re-reads.
 */
let cachedParams: { contract: string; params: LegionParams } | null = null;

export async function getParams(opts: ChainReadOptions = {}): Promise<LegionParams> {
  if (cachedParams?.contract === LEGION_GOV_CONTRACT) return cachedParams.params;
  const raw = await callReadOnly(LEGION_GOV_CONTRACT, "get-params", [], opts);
  const num = (k: string) => asNumber(tupleField(raw, k));
  const params: LegionParams = {
    votingQuorum: num("votingQuorum"),
    votingThreshold: num("votingThreshold"),
    vetoQuorum: num("vetoQuorum"),
    minParticipants: num("minParticipants"),
    minWeight: num("minWeight"),
    drawBps: num("drawBps"),
    bondBps: num("bondBps"),
    minBond: num("minBond"),
    voteWindow: num("voteWindow"),
    vetoWindow: num("vetoWindow"),
    concludeWindow: num("concludeWindow"),
    proposeInterval: num("proposeInterval"),
  };
  cachedParams = { contract: LEGION_GOV_CONTRACT, params };
  return params;
}

/** Pool-level scalars, fetched together since the page shows them as a unit. */
export async function getPoolStats(opts: ChainReadOptions = {}): Promise<{
  totalWeight: number;
  quoteDraw: number;
  nextProposeHeight: number;
  treasuryBalance: number;
}> {
  const [totalWeight, quoteDraw, nextProposeHeight, treasuryBalance] = await Promise.all([
    callReadOnly(LEGION_GOV_CONTRACT, "get-total-weight", [], opts),
    callReadOnly(LEGION_GOV_CONTRACT, "quote-draw", [], opts),
    callReadOnly(LEGION_GOV_CONTRACT, "get-next-propose-height", [], opts),
    callReadOnly(LEGION_TREASURY_CONTRACT, "get-balance", [], opts),
  ]);

  return {
    totalWeight: asNumber(totalWeight),
    quoteDraw: asNumber(quoteDraw),
    nextProposeHeight: asNumber(nextProposeHeight),
    treasuryBalance: asNumber(unwrapOptional(treasuryBalance) ?? treasuryBalance),
  };
}

export interface OutcomePrediction {
  outcome: PredictedOutcome;
  quorumMet: boolean;
  thresholdMet: boolean;
  vetoed: boolean;
  poolShort: boolean;
  /** Weight actually cast (yes + no); excludes vetoes, counted separately. */
  cast: number;
  turnoutPct: number;
  approvalPct: number;
  vetoPct: number;
  /** What each signal would earn. Zero means the dust guard would bite. */
  perSignal: number;
}

/**
 * Compute the verdict `conclude` would write right now.
 *
 * Mirrors the contract's branch order exactly, and the order is load-bearing:
 * lapsed → veto → quorum → threshold → pool-short → passed. A week that is both
 * vetoed and short of quorum resolves as vetoed, a week that lost its vote
 * reports that rather than a pool problem, and past the conclude window nothing
 * else is reachable at all.
 *
 * Integer division matches Clarity's truncation. Floating-point percentages
 * would let a brief sitting exactly on a boundary predict differently from how
 * it actually concludes.
 *
 * `treasuryBalance` is compared against the real disbursement
 * (`perSignal × totalSignals`), not the snapshotted draw, because floor
 * truncation makes the actual spend up to `totalSignals - 1` sats lower.
 */
export function predictOutcome(
  brief: Pick<
    BriefRecord,
    | "yesWeight"
    | "noWeight"
    | "vetoWeight"
    | "voterCount"
    | "eligibleSnapshot"
    | "draw"
    | "totalSignals"
  >,
  params: Pick<
    LegionParams,
    "votingQuorum" | "votingThreshold" | "vetoQuorum" | "minParticipants"
  >,
  treasuryBalance: number,
  /** True once the conclude window has closed. Short-circuits every other branch. */
  lapsed = false
): OutcomePrediction {
  const eligible = brief.eligibleSnapshot;
  const cast = brief.yesWeight + brief.noWeight;

  const turnoutPct = eligible > 0 ? Math.floor((cast * 100) / eligible) : 0;
  const approvalPct = cast > 0 ? Math.floor((brief.yesWeight * 100) / cast) : 0;
  const vetoPct = eligible > 0 ? Math.floor((brief.vetoWeight * 100) / eligible) : 0;

  const vetoed = eligible > 0 && vetoPct >= params.vetoQuorum;
  const quorumMet =
    eligible > 0 &&
    brief.voterCount >= params.minParticipants &&
    turnoutPct >= params.votingQuorum;
  const thresholdMet = cast > 0 && approvalPct >= params.votingThreshold;

  const perSignal =
    brief.totalSignals > 0 ? Math.floor(brief.draw / brief.totalSignals) : 0;
  const poolShort = perSignal * brief.totalSignals > treasuryBalance;

  let outcome: PredictedOutcome;
  // The contract tests lapsed before anything else: past the window a week can
  // only fail, however its vote went.
  if (lapsed) outcome = "NOT_CONCLUDED";
  else if (vetoed) outcome = "VETOED";
  else if (!quorumMet) outcome = "NO_QUORUM";
  else if (!thresholdMet) outcome = "VOTED_DOWN";
  else if (poolShort) outcome = "POOL_SHORT";
  else outcome = "PASSED";

  return {
    outcome,
    quorumMet,
    thresholdMet,
    vetoed,
    poolShort,
    cast,
    turnoutPct,
    approvalPct,
    vetoPct,
    perSignal,
  };
}

/**
 * Blocks until the current phase ends, or null when there is no next boundary.
 *
 * Three phases are timed: voting, veto, and concludable. The last is the one
 * worth surfacing loudest — when it runs out the week can no longer pay.
 */
export function blocksRemaining(
  brief: Pick<BriefRecord, "voteEnd"> | null,
  phase: LegionPhase,
  tipHeight: number,
  vetoWindow: number,
  concludeWindow: number
): number | null {
  const end = nextBoundaryHeight(brief, phase, vetoWindow, concludeWindow);
  return end === null ? null : Math.max(0, end - tipHeight);
}

/** Height at which the current phase ends, or null when it has no deadline. */
export function nextBoundaryHeight(
  brief: Pick<BriefRecord, "voteEnd"> | null,
  phase: LegionPhase,
  vetoWindow: number,
  concludeWindow: number
): number | null {
  if (!brief) return null;
  if (phase === "voting") return brief.voteEnd;
  if (phase === "veto") return brief.voteEnd + vetoWindow;
  // The window that matters most: past it the payout is gone, not merely late.
  if (phase === "concludable") return brief.voteEnd + vetoWindow + concludeWindow;
  return null;
}
