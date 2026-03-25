import type { Env, Beat, Signal, SignalStatus, Source, Brief, Classified, ClassifiedStatus, Streak, Earning, Correction, ReferralCredit, BriefSignal, CompiledBriefData, DOResult, DOErrorStatus, PayoutRecord, WeeklyPayoutResult } from "./types";
import { CLASSIFIED_BRIEF_SLOTS } from "./constants";

/** Singleton DO stub ID — single instance manages all news data */
const DO_ID_NAME = "news-singleton";

/** Get a stub for the news DO */
function getStub(env: Env): DurableObjectStub {
  const id = env.NEWS_DO.idFromName(DO_ID_NAME);
  return env.NEWS_DO.get(id);
}

/** Type-safe fetch helper */
async function doFetch<T>(
  stub: DurableObjectStub,
  path: string,
  init?: RequestInit
): Promise<DOResult<T>> {
  const res = await stub.fetch(`https://do${path}`, init);
  const data = (await res.json()) as DOResult<T>;
  if (!data.ok) {
    return { ...data, status: res.status as DOErrorStatus };
  }
  return data;
}

// ---------------------------------------------------------------------------
// Beats
// ---------------------------------------------------------------------------

export async function listBeats(env: Env): Promise<Beat[]> {
  const stub = getStub(env);
  const result = await doFetch<Beat[]>(stub, "/beats");
  if (!result.ok) throw new Error(result.error ?? "Failed to list beats");
  if (result.data === undefined) throw new Error("Missing data in response");
  return result.data;
}

export async function getBeat(env: Env, slug: string): Promise<Beat | null> {
  const stub = getStub(env);
  const result = await doFetch<Beat>(
    stub,
    `/beats/${encodeURIComponent(slug)}`
  );
  return result.ok ? (result.data ?? null) : null;
}

export async function createBeat(
  env: Env,
  beat: Omit<Beat, "created_at" | "updated_at">
): Promise<DOResult<Beat>> {
  const stub = getStub(env);
  return doFetch<Beat>(stub, "/beats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(beat),
  });
}

export async function updateBeat(
  env: Env,
  slug: string,
  updates: Partial<Beat>
): Promise<DOResult<Beat>> {
  const stub = getStub(env);
  return doFetch<Beat>(stub, `/beats/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

export async function deleteBeat(
  env: Env,
  slug: string,
  btcAddress: string
): Promise<DOResult<{ slug: string; deleted: boolean; signals_deleted: number }>> {
  const stub = getStub(env);
  return doFetch<{ slug: string; deleted: boolean; signals_deleted: number }>(
    stub,
    `/beats/${encodeURIComponent(slug)}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ btc_address: btcAddress }),
    }
  );
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export interface SignalFilters {
  beat?: string;
  agent?: string;
  tag?: string;
  since?: string;
  status?: string;
  limit?: number;
}

export interface FrontPagePageResult {
  signals: Signal[];
  date: string | null;
  hasMore: boolean;
}


export async function listSignals(
  env: Env,
  filters: SignalFilters = {}
): Promise<Signal[]> {
  const stub = getStub(env);
  const params = new URLSearchParams();
  if (filters.beat) params.set("beat", filters.beat);
  if (filters.agent) params.set("agent", filters.agent);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.since) params.set("since", filters.since);
  if (filters.status) params.set("status", filters.status);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  const qs = params.toString();
  const result = await doFetch<Signal[]>(stub, `/signals${qs ? `?${qs}` : ""}`);
  if (!result.ok) throw new Error(result.error ?? "Failed to list signals");
  if (result.data === undefined) throw new Error("Missing data in response");
  return result.data;
}

/** All data needed for the initial page load, fetched in a single DO call. */
export interface InitBundle {
  brief: Brief | null;
  briefDates: string[];
  beats: Beat[];
  claims: Array<{ beat_slug: string; btc_address: string; claimed_at: string }>;
  classifieds: Classified[];
  correspondents: CorrespondentRow[];
  leaderboard: LeaderboardEntry[];
  signals: Signal[];
}

/** Fetch all initial page load data in a single DO round-trip. */
export async function getInitBundle(env: Env): Promise<InitBundle> {
  const stub = getStub(env);
  const result = await doFetch<InitBundle>(stub, "/init");
  if (!result.ok) throw new Error(result.error ?? "Failed to get init bundle");
  if (result.data === undefined) throw new Error("Missing data in response");
  return result.data;
}

/** Fetch all approved + brief_included signals in a single DO call. */
export async function listFrontPage(env: Env): Promise<Signal[]> {
  const stub = getStub(env);
  const result = await doFetch<Signal[]>(stub, "/signals/front-page");
  if (!result.ok) throw new Error(result.error ?? "Failed to list front-page signals");
  if (result.data === undefined) throw new Error("Missing data in response");
  return result.data;
}

/** Fetch one day of curated signals strictly before `before` (YYYY-MM-DD) for infinite scroll. */
export async function listFrontPagePage(
  env: Env,
  before: string,
  limit = 50
): Promise<FrontPagePageResult> {
  const stub = getStub(env);
  const params = new URLSearchParams({ before, limit: String(limit) });
  const result = await doFetch<FrontPagePageResult>(
    stub,
    `/signals/front-page-page?${params.toString()}`
  );
  if (!result.ok) {
    throw new Error(result.error ?? "Failed to fetch front-page page");
  }
  if (!result.data) {
    throw new Error("Missing data in front-page page response");
  }
  return result.data;
}

export async function getSignal(
  env: Env,
  id: string
): Promise<Signal | null> {
  const stub = getStub(env);
  const result = await doFetch<Signal>(
    stub,
    `/signals/${encodeURIComponent(id)}`
  );
  return result.ok ? (result.data ?? null) : null;
}

export interface CreateSignalInput {
  beat_slug: string;
  btc_address: string;
  headline: string;
  body?: string | null;
  sources: Source[];
  tags: string[];
  signature?: string;
  disclosure?: string;
}

export interface CooldownInfo {
  waitMinutes: number;
}

export type CreateSignalResult = DOResult<Signal> & { cooldown?: CooldownInfo };

export async function createSignal(
  env: Env,
  signal: CreateSignalInput
): Promise<CreateSignalResult> {
  const stub = getStub(env);
  const res = await stub.fetch("https://do/signals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signal),
  });
  const data = (await res.json()) as CreateSignalResult;
  if (!data.ok) {
    return { ...data, status: res.status as DOErrorStatus };
  }
  return data;
}

export interface CorrectionInput {
  btc_address: string;
  headline?: string;
  body?: string | null;
  sources?: Source[];
  tags?: string[];
  signature?: string;
}

export interface SignalCountsFilters {
  beat?: string;
  agent?: string;
  since?: string;
}

export interface SignalCounts {
  submitted: number;
  in_review: number;
  approved: number;
  rejected: number;
  brief_included: number;
  total: number;
}

export async function getSignalCounts(
  env: Env,
  filters: SignalCountsFilters = {}
): Promise<SignalCounts> {
  const stub = getStub(env);
  const params = new URLSearchParams();
  if (filters.beat) params.set("beat", filters.beat);
  if (filters.agent) params.set("agent", filters.agent);
  if (filters.since) params.set("since", filters.since);
  const qs = params.toString();
  const result = await doFetch<SignalCounts>(stub, `/signals/counts${qs ? `?${qs}` : ""}`);
  if (!result.ok) throw new Error(result.error ?? "Failed to get signal counts");
  if (result.data === undefined) throw new Error("Missing data in response");
  return result.data;
}

export async function correctSignal(
  env: Env,
  id: string,
  correction: CorrectionInput
): Promise<DOResult<Signal>> {
  const stub = getStub(env);
  return doFetch<Signal>(stub, `/signals/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(correction),
  });
}

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

export async function listBriefDates(env: Env): Promise<string[]> {
  const stub = getStub(env);
  const result = await doFetch<string[]>(stub, "/briefs/dates");
  if (!result.ok) throw new Error(result.error ?? "Failed to list brief dates");
  if (result.data === undefined) throw new Error("Missing data in response");
  return result.data;
}

export async function getLatestBrief(env: Env): Promise<Brief | null> {
  const stub = getStub(env);
  const result = await doFetch<Brief>(stub, "/briefs/latest");
  return result.ok ? (result.data ?? null) : null;
}

export async function getBriefByDate(env: Env, date: string): Promise<Brief | null> {
  const stub = getStub(env);
  const result = await doFetch<Brief>(stub, `/briefs/${encodeURIComponent(date)}`);
  return result.ok ? (result.data ?? null) : null;
}

export async function compileBriefData(
  env: Env,
  date?: string
): Promise<DOResult<CompiledBriefData>> {
  const stub = getStub(env);
  return doFetch<CompiledBriefData>(stub, "/briefs/compile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(date ? { date } : {}),
  });
}

export interface SaveBriefInput {
  date: string;
  text: string;
  json_data: string | null;
  compiled_at: string;
}

export async function saveBrief(env: Env, brief: SaveBriefInput): Promise<DOResult<Brief>> {
  const stub = getStub(env);
  return doFetch<Brief>(stub, "/briefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(brief),
  });
}

export interface BriefUpdates {
  inscribed_txid?: string | null;
  inscription_id?: string | null;
}

export async function updateBrief(
  env: Env,
  date: string,
  updates: BriefUpdates
): Promise<DOResult<Brief>> {
  const stub = getStub(env);
  return doFetch<Brief>(stub, `/briefs/${encodeURIComponent(date)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

// ---------------------------------------------------------------------------
// Classifieds
// ---------------------------------------------------------------------------

export interface ClassifiedFilters {
  category?: string;
  agent?: string;
  limit?: number;
}

export async function listClassifieds(
  env: Env,
  filters: ClassifiedFilters = {}
): Promise<Classified[]> {
  const stub = getStub(env);
  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
  if (filters.agent) params.set("agent", filters.agent);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  const qs = params.toString();
  const result = await doFetch<Classified[]>(stub, `/classifieds${qs ? `?${qs}` : ""}`);
  if (!result.ok) throw new Error(result.error ?? "Failed to list classifieds");
  if (result.data === undefined) throw new Error("Missing data in response");
  return result.data;
}

export async function getClassified(
  env: Env,
  id: string
): Promise<Classified | null> {
  const stub = getStub(env);
  const result = await doFetch<Classified>(stub, `/classifieds/${encodeURIComponent(id)}`);
  return result.ok ? (result.data ?? null) : null;
}

export interface CreateClassifiedInput {
  btc_address: string;
  category: string;
  headline: string;
  body?: string | null;
  payment_txid?: string | null;
}

export async function createClassified(
  env: Env,
  classified: CreateClassifiedInput
): Promise<DOResult<Classified>> {
  const stub = getStub(env);
  return doFetch<Classified>(stub, "/classifieds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(classified),
  });
}

export interface ReviewClassifiedInput {
  btc_address: string;
  status: ClassifiedStatus;
  feedback?: string | null;
}

export async function reviewClassified(
  env: Env,
  classifiedId: string,
  input: ReviewClassifiedInput
): Promise<DOResult<Classified>> {
  const stub = getStub(env);
  return doFetch<Classified>(stub, `/classifieds/${encodeURIComponent(classifiedId)}/review`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export interface RecordClassifiedRefundInput {
  btc_address: string;
  refund_txid: string;
}

export async function recordClassifiedRefund(
  env: Env,
  classifiedId: string,
  input: RecordClassifiedRefundInput
): Promise<DOResult<Classified>> {
  const stub = getStub(env);
  return doFetch<Classified>(stub, `/classifieds/${encodeURIComponent(classifiedId)}/refund`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function listPendingClassifieds(env: Env, btcAddress: string): Promise<Classified[]> {
  const stub = getStub(env);
  const params = new URLSearchParams({ btc_address: btcAddress });
  const result = await doFetch<Classified[]>(stub, `/classifieds/pending?${params}`);
  if (!result.ok) throw new Error(result.error ?? "Failed to list pending classifieds");
  if (result.data === undefined) throw new Error("Missing data in response");
  return result.data;
}

export async function getClassifiedsRotation(
  env: Env,
  maxChars?: number
): Promise<{ ok: boolean; data: Classified[]; slots: number; filled: number }> {
  const stub = getStub(env);
  const url = maxChars
    ? `/classifieds/rotation?max_chars=${maxChars}`
    : "/classifieds/rotation";
  const result = await doFetch<{ data: Classified[]; slots: number; filled: number }>(stub, url);
  if (!result.ok || !result.data) {
    return { ok: false, data: [], slots: CLASSIFIED_BRIEF_SLOTS, filled: 0 };
  }
  return { ok: true, ...result.data };
}

// ---------------------------------------------------------------------------
// Correspondents
// ---------------------------------------------------------------------------

export interface CorrespondentRow {
  btc_address: string;
  signal_count: number;
  last_signal: string;
  days_active: number;
  current_streak: number | null;
  longest_streak: number | null;
  total_signals: number | null;
  last_signal_date: string | null;
}

export async function listCorrespondents(env: Env): Promise<CorrespondentRow[]> {
  const stub = getStub(env);
  const result = await doFetch<CorrespondentRow[]>(stub, "/correspondents");
  if (!result.ok) throw new Error(result.error ?? "Failed to list correspondents");
  if (result.data === undefined) throw new Error("Missing data in response");
  return result.data;
}

export interface CorrespondentsBundleResult {
  correspondents: CorrespondentRow[];
  beats: Beat[];
  claims: Array<{ beat_slug: string; btc_address: string; claimed_at: string }>;
  leaderboard: LeaderboardEntry[];
}

/** Fetch correspondents, beats, and leaderboard in a single DO round-trip. */
export async function getCorrespondentsBundle(env: Env): Promise<CorrespondentsBundleResult> {
  const stub = getStub(env);
  const result = await doFetch<CorrespondentsBundleResult>(stub, "/correspondents-bundle");
  if (!result.ok) throw new Error(result.error ?? "Failed to get correspondents bundle");
  if (result.data === undefined) throw new Error("Missing data in response");
  return result.data;
}

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

export async function listStreaks(
  env: Env,
  limit?: number
): Promise<Streak[]> {
  const stub = getStub(env);
  const qs = limit !== undefined ? `?limit=${limit}` : "";
  const result = await doFetch<Streak[]>(stub, `/streaks${qs}`);
  if (!result.ok) throw new Error(result.error ?? "Failed to list streaks");
  if (result.data === undefined) throw new Error("Missing data in response");
  return result.data;
}

// ---------------------------------------------------------------------------
// Agent Status
// ---------------------------------------------------------------------------

export interface StatusAction {
  type: "claim-beat" | "file-signal" | "wait" | "maintain-streak" | "compile-brief" | "inscribe-brief";
  description: string;
  waitMinutes?: number;
}

export interface AgentStatusData {
  address: string;
  /** @deprecated Use `beats` array instead */
  beat: Record<string, unknown> | null;
  /** @deprecated Use `beats` array instead */
  beatStatus: "active" | "inactive" | null;
  beats: Array<Record<string, unknown> & { beatStatus: "active" | "inactive" }>;
  signals: Signal[];
  totalSignals: number;
  streak: Streak | null;
  earnings: Earning[];
  canFileSignal: boolean;
  waitMinutes: number | null;
  actions: StatusAction[];
}

export async function getAgentStatus(
  env: Env,
  address: string
): Promise<AgentStatusData | null> {
  const stub = getStub(env);
  const result = await doFetch<AgentStatusData>(
    stub,
    `/status/${encodeURIComponent(address)}`
  );
  return result.ok ? (result.data ?? null) : null;
}

// ---------------------------------------------------------------------------
// Inscriptions
// ---------------------------------------------------------------------------

export interface InscriptionRow {
  date: string;
  inscribed_txid: string;
  inscription_id: string;
}

export async function listInscriptions(env: Env): Promise<InscriptionRow[]> {
  const stub = getStub(env);
  const result = await doFetch<InscriptionRow[]>(stub, "/inscriptions");
  if (!result.ok) throw new Error(result.error ?? "Failed to list inscriptions");
  if (result.data === undefined) throw new Error("Missing data in response");
  return result.data;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ReportData {
  date: string;
  yesterday: string;
  signalsToday: number;
  totalSignals: number;
  totalBeats: number;
  activeCorrespondents: number;
  latestBrief: { date: string; inscribed_txid: string | null; inscription_id: string | null } | null;
  topAgents: { btc_address: string; signal_count: number }[];
}

export async function getReport(env: Env): Promise<ReportData | null> {
  const stub = getStub(env);
  const result = await doFetch<ReportData>(stub, "/report");
  return result.ok ? (result.data ?? null) : null;
}

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------

export interface RecordEarningInput {
  btc_address: string;
  amount_sats: number;
  reason: string;
  reference_id?: string | null;
}

export async function recordEarning(
  env: Env,
  earning: RecordEarningInput
): Promise<DOResult<Earning>> {
  const stub = getStub(env);
  return doFetch<Earning>(stub, "/earnings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(earning),
  });
}

export async function listEarnings(
  env: Env,
  address: string
): Promise<Earning[]> {
  const stub = getStub(env);
  const result = await doFetch<Earning[]>(
    stub,
    `/earnings/${encodeURIComponent(address)}`
  );
  if (!result.ok) throw new Error(result.error ?? "Failed to list earnings");
  if (result.data === undefined) throw new Error("Missing data in response");
  return result.data;
}

export interface UnpaidEarningRow {
  btc_address: string;
  total_unpaid_sats: number;
  pending_count: number;
}

export async function listUnpaidEarnings(
  env: Env,
  publisherAddress: string
): Promise<DOResult<UnpaidEarningRow[]>> {
  const stub = getStub(env);
  const params = new URLSearchParams({ btc_address: publisherAddress });
  return doFetch<UnpaidEarningRow[]>(stub, `/earnings/unpaid?${params}`);
}

export interface UpdateEarningInput {
  btc_address: string;
  payout_txid: string;
}

export async function updateEarning(
  env: Env,
  id: string,
  input: UpdateEarningInput
): Promise<DOResult<Earning>> {
  const stub = getStub(env);
  return doFetch<Earning>(stub, `/earnings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ConfigEntry {
  key: string;
  value: string;
  updated_at: string;
}

export async function getConfig(env: Env, key: string): Promise<ConfigEntry | null> {
  const stub = getStub(env);
  const result = await doFetch<ConfigEntry>(stub, `/config/${encodeURIComponent(key)}`);
  if (result.ok) return result.data ?? null;
  // 404 is a normal "not set" — return null
  if (result.status === 404) return null;
  // Any other error (DO crash, 500) — throw so callers can fail closed
  throw new Error(result.error ?? "Failed to fetch config");
}

export async function setConfig(env: Env, key: string, value: string): Promise<DOResult<ConfigEntry>> {
  const stub = getStub(env);
  return doFetch<ConfigEntry>(stub, `/config/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

// ---------------------------------------------------------------------------
// Signal Review (Publisher editorial actions)
// ---------------------------------------------------------------------------

export interface ReviewSignalInput {
  btc_address: string;
  status: SignalStatus;
  feedback?: string | null;
}

export async function reviewSignal(
  env: Env,
  signalId: string,
  input: ReviewSignalInput
): Promise<DOResult<Signal>> {
  const stub = getStub(env);
  return doFetch<Signal>(stub, `/signals/${encodeURIComponent(signalId)}/review`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// Brief Signals (inclusion tracking)
// ---------------------------------------------------------------------------

export async function recordBriefSignals(
  env: Env,
  briefDate: string,
  signalIds: string[]
): Promise<DOResult<{ brief_date: string; count: number; signals: BriefSignal[] }>> {
  const stub = getStub(env);
  return doFetch(stub, "/brief-signals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief_date: briefDate, signal_ids: signalIds }),
  });
}

export async function getBriefSignals(env: Env, date: string): Promise<unknown[]> {
  const stub = getStub(env);
  const result = await doFetch<unknown[]>(stub, `/brief-signals/${encodeURIComponent(date)}`);
  if (!result.ok) throw new Error(result.error ?? "Failed to get brief signals");
  return result.data ?? [];
}

// ---------------------------------------------------------------------------
// Corrections (fact-checker)
// ---------------------------------------------------------------------------

export interface CreateCorrectionInput {
  signal_id: string;
  btc_address: string;
  claim: string;
  correction: string;
  sources?: string | null;
}

export async function createCorrection(
  env: Env,
  input: CreateCorrectionInput
): Promise<DOResult<Correction>> {
  const stub = getStub(env);
  return doFetch<Correction>(stub, "/corrections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function listCorrections(env: Env, signalId: string): Promise<Correction[]> {
  const stub = getStub(env);
  const result = await doFetch<Correction[]>(stub, `/corrections/signal/${encodeURIComponent(signalId)}`);
  if (!result.ok) throw new Error(result.error ?? "Failed to list corrections");
  return result.data ?? [];
}

export async function listAllCorrections(
  env: Env,
  publisherAddress: string,
  status?: string
): Promise<DOResult<Correction[]>> {
  const stub = getStub(env);
  const params = new URLSearchParams({ btc_address: publisherAddress });
  if (status) params.set("status", status);
  return doFetch<Correction[]>(stub, `/corrections?${params}`);
}

export interface ReviewCorrectionInput {
  btc_address: string;
  status: "approved" | "rejected";
}

export async function reviewCorrection(
  env: Env,
  correctionId: string,
  input: ReviewCorrectionInput
): Promise<DOResult<Correction>> {
  const stub = getStub(env);
  return doFetch<Correction>(stub, `/corrections/${encodeURIComponent(correctionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// Referral Credits (scout)
// ---------------------------------------------------------------------------

export async function registerReferral(
  env: Env,
  scoutAddress: string,
  recruitAddress: string
): Promise<DOResult<ReferralCredit>> {
  const stub = getStub(env);
  return doFetch<ReferralCredit>(stub, "/referrals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scout_address: scoutAddress, recruit_address: recruitAddress }),
  });
}

export async function creditReferral(
  env: Env,
  recruitAddress: string,
  signalId: string
): Promise<DOResult<{ credited: boolean; recruit_address?: string; signal_id?: string }>> {
  const stub = getStub(env);
  return doFetch(stub, "/referrals/credit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recruit_address: recruitAddress, signal_id: signalId }),
  });
}

// ---------------------------------------------------------------------------
// Payouts — brief inclusion and weekly leaderboard prizes
// ---------------------------------------------------------------------------

export interface BriefInclusionPayoutResult {
  brief_date: string;
  paid: number;
  skipped: number;
}

/** Record brief-inclusion earnings for a set of signal IDs. Idempotent — already-paid signals are skipped. */
export async function recordBriefInclusionPayouts(
  env: Env,
  briefDate: string,
  signalIds: string[]
): Promise<DOResult<BriefInclusionPayoutResult>> {
  const stub = getStub(env);
  return doFetch<BriefInclusionPayoutResult>(stub, "/payouts/brief-inclusion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief_date: briefDate, signal_ids: signalIds }),
  });
}

/** Record top-3 weekly leaderboard prize earnings for the given ISO week. Idempotent. */
export async function recordWeeklyPayouts(
  env: Env,
  week: string
): Promise<DOResult<WeeklyPayoutResult>> {
  const stub = getStub(env);
  return doFetch<WeeklyPayoutResult>(stub, "/payouts/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ week }),
  });
}

// ---------------------------------------------------------------------------
// Leaderboard v2 (weighted scoring)
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  btc_address: string;
  brief_inclusions_30d: number;
  signal_count_30d: number;
  current_streak: number;
  days_active_30d: number;
  approved_corrections_30d: number;
  referral_credits_30d: number;
  score: number;
  total_earned_sats: number;
}

export async function getLeaderboard(env: Env): Promise<LeaderboardEntry[]> {
  const stub = getStub(env);
  const result = await doFetch<LeaderboardEntry[]>(stub, "/leaderboard");
  if (!result.ok) throw new Error(result.error ?? "Failed to get leaderboard");
  return result.data ?? [];
}

/** Per-address score verification result from raw table recalculation. */
export interface VerifyScoreResult {
  address: string;
  components: {
    brief_inclusions_30d: number;
    signal_count_30d: number;
    current_streak: number;
    days_active_30d: number;
    approved_corrections_30d: number;
    referral_credits_30d: number;
  };
  component_scores: {
    brief_inclusions: number;
    signal_count: number;
    current_streak: number;
    days_active: number;
    approved_corrections: number;
    referral_credits: number;
  };
  total_score: number;
  rank: number;
}

/** Recalculate a single scout's score from raw tables. Public endpoint. */
export async function verifyLeaderboardScore(
  env: Env,
  address: string
): Promise<DOResult<VerifyScoreResult>> {
  const stub = getStub(env);
  return doFetch<VerifyScoreResult>(stub, `/leaderboard/verify/${encodeURIComponent(address)}`);
}

/** Snapshot metadata row (no snapshot_data payload). */
export interface SnapshotMeta {
  id: string;
  snapshot_type: string;
  week: string | null;
  created_at: string;
}

/** Full snapshot row including parsed snapshot_data. */
export interface SnapshotFull extends SnapshotMeta {
  snapshot_data: LeaderboardEntry[];
}

/** List stored leaderboard snapshots (metadata only, Publisher-only). */
export async function listLeaderboardSnapshots(
  env: Env,
  publisherAddress: string
): Promise<SnapshotMeta[]> {
  const stub = getStub(env);
  const params = new URLSearchParams({ btc_address: publisherAddress });
  const result = await doFetch<SnapshotMeta[]>(stub, `/leaderboard/snapshots?${params}`);
  if (!result.ok) throw new Error(result.error ?? "Failed to list leaderboard snapshots");
  return result.data ?? [];
}

/** Retrieve a specific snapshot with full data (Publisher-only). */
export async function getLeaderboardSnapshot(
  env: Env,
  id: string,
  publisherAddress: string
): Promise<DOResult<SnapshotFull>> {
  const stub = getStub(env);
  const params = new URLSearchParams({ btc_address: publisherAddress });
  return doFetch<SnapshotFull>(stub, `/leaderboard/snapshots/${encodeURIComponent(id)}?${params}`);
}

/** Result of a leaderboard reset operation. */
export interface ResetLeaderboardResult {
  snapshot_id: string;
  deleted: {
    brief_signals: number;
    streaks: number;
    corrections: number;
    referral_credits: number;
    earnings: number;
  };
  pruned_snapshots: number;
}

/** Snapshot the leaderboard, clear 5 scoring tables, and prune old snapshots to keep 10. Publisher-only. */
export async function resetLeaderboard(
  env: Env,
  publisherAddress: string
): Promise<DOResult<ResetLeaderboardResult>> {
  const stub = getStub(env);
  return doFetch<ResetLeaderboardResult>(stub, "/leaderboard/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ btc_address: publisherAddress }),
  });
}

