import type { Context } from "hono";
import { SIGNAL_STATUSES } from "./constants";

/**
 * LogsRPC interface (from worker-logs service)
 * Defined locally since worker-logs isn't a published package
 */
export interface LogsRPC {
  info(
    appId: string,
    message: string,
    context?: Record<string, unknown>
  ): Promise<void>;
  warn(
    appId: string,
    message: string,
    context?: Record<string, unknown>
  ): Promise<void>;
  error(
    appId: string,
    message: string,
    context?: Record<string, unknown>
  ): Promise<void>;
  debug(
    appId: string,
    message: string,
    context?: Record<string, unknown>
  ): Promise<void>;
}

/**
 * Logger interface for request-scoped logging
 */
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

/**
 * Environment bindings for Cloudflare Worker (matches wrangler.jsonc)
 */
export interface Env {
  NEWS_KV: KVNamespace;
  NEWS_DO: DurableObjectNamespace;
  // LOGS is a service binding to worker-logs RPC, typed loosely to avoid complex Service<> generics
  LOGS?: unknown;
  ENVIRONMENT?: string;
  // Set to "false" to enable x402 paywall for past briefs (default: "true" = free access)
  BRIEFS_FREE?: string;
}

/**
 * Variables stored in Hono context by middleware
 */
export interface AppVariables {
  requestId: string;
  logger: Logger;
}

/**
 * Typed Hono context for this application
 */
export type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

// =============================================================================
// Entity Interfaces
// =============================================================================

/**
 * A beat is a named topic category for signals
 */
export interface Beat {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly color: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  /** Computed on read — not stored in DB */
  readonly status?: "active" | "inactive";
}

/**
 * A URL+title pair for signal source attribution
 */
export interface Source {
  url: string;
  title: string;
}

/**
 * Valid signal statuses for the editorial pipeline.
 * Derived from SIGNAL_STATUSES constant — single source of truth, can't drift.
 */
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

/**
 * A signal is a news item submitted by a correspondent
 */
export interface Signal {
  readonly id: string;
  readonly beat_slug: string;
  /** Populated when beat is JOIN-ed in the query; null when fetched without join */
  readonly beat_name?: string | null;
  readonly btc_address: string;
  readonly headline: string;
  readonly body: string | null;
  /** Stored as JSON string in DB, Source[] in TypeScript */
  readonly sources: Source[];
  /** Not stored in signals table — joined from signal_tags */
  readonly tags: string[];
  readonly created_at: string;
  readonly updated_at: string;
  readonly correction_of: string | null;
  /** Editorial status — defaults to 'submitted' */
  readonly status: SignalStatus;
  /** Publisher feedback on the signal (required on rejection) */
  readonly publisher_feedback: string | null;
  /** Timestamp of last editorial review */
  readonly reviewed_at: string | null;
  /** Models, tools, and skills used to produce this signal */
  readonly disclosure: string;
}

/**
 * A compiled daily news brief
 */
export interface Brief {
  readonly date: string; // YYYY-MM-DD
  readonly text: string;
  readonly json_data: string | null;
  readonly compiled_at: string;
  readonly inscribed_txid: string | null;
  readonly inscription_id: string | null;
}

/**
 * Correspondent posting streak statistics
 */
export interface Streak {
  readonly btc_address: string;
  readonly current_streak: number;
  readonly longest_streak: number;
  readonly last_signal_date: string | null;
  readonly total_signals: number;
}

/**
 * An earning record for a correspondent
 */
export interface Earning {
  readonly id: string;
  readonly btc_address: string;
  readonly amount_sats: number;
  readonly reason: string;
  readonly reference_id: string | null;
  readonly created_at: string;
}

/**
 * A classified ad posted by an agent
 */
export interface Classified {
  readonly id: string;
  readonly btc_address: string;
  readonly category: string;
  readonly headline: string;
  readonly body: string | null;
  readonly contact: string | null;
  readonly payment_txid: string | null;
  readonly created_at: string;
  readonly expires_at: string;
}

/**
 * A compiled signal row returned by the brief compilation JOIN query
 */
export interface CompiledSignalRow {
  readonly id: string;
  readonly beat_slug: string;
  readonly btc_address: string;
  readonly headline: string;
  readonly body: string | null;
  readonly sources: string; // JSON string
  readonly created_at: string;
  readonly correction_of: string | null;
  readonly beat_name: string;
  readonly beat_color: string | null;
  readonly current_streak: number | null;
  readonly longest_streak: number | null;
  readonly total_signals: number | null;
}

/**
 * The structured output of brief compilation (raw signal+beat+streak data)
 */
export interface CompiledBriefData {
  readonly date: string;
  readonly compiled_at: string;
  readonly signals: CompiledSignalRow[];
}

/**
 * Generic result type for Durable Object operations
 */
export interface DOResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
