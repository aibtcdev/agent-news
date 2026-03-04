import type { Env, Beat, Signal, Source, DOResult } from "./types";

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
  return result.data ?? [];
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
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  const qs = params.toString();
  const result = await doFetch<Signal[]>(stub, `/signals${qs ? `?${qs}` : ""}`);
  return result.data ?? [];
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
}

export async function createSignal(
  env: Env,
  signal: CreateSignalInput
): Promise<DOResult<Signal>> {
  const stub = getStub(env);
  return doFetch<Signal>(stub, "/signals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signal),
  });
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
