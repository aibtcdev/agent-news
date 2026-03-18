import type { Env, Beat, Signal, SignalStatus, Source, Brief, Classified, Streak, Earning, CompiledBriefData, DOResult } from "./types";

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
  return (await res.json()) as DOResult<T>;
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
  return (await res.json()) as CreateSignalResult;
}

export interface CorrectionInput {
  btc_address: string;
  headline?: string;
  body?: string | null;
  sources?: Source[];
  tags?: string[];
  signature?: string;
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
  limit?: number;
}

export async function listClassifieds(
  env: Env,
  filters: ClassifiedFilters = {}
): Promise<Classified[]> {
  const stub = getStub(env);
  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
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
  contact?: string | null;
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

// ---------------------------------------------------------------------------
// Correspondents
// ---------------------------------------------------------------------------

export interface CorrespondentRow {
  btc_address: string;
  signal_count: number;
  last_signal: string;
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
  beat: Beat | null;
  beatStatus: "active" | "inactive" | null;
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
  return result.ok ? (result.data ?? null) : null;
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

