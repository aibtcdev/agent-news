import type { Context } from "hono";
import { SIGNAL_STATUSES, CLASSIFIED_STATUSES } from "./constants";

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
 * Settlement options passed to RelayRPC.submitPayment().
 * Mirrors SettleOptions in x402-sponsor-relay/src/types.ts.
 */
export interface SettleOptions {
  /** Expected recipient Stacks address */
  expectedRecipient: string;
  /** Minimum payment amount (smallest unit — microSTX or sats) as a string */
  minAmount: string;
  /** Token type (defaults to STX on the relay side) */
  tokenType?: string;
  /** Expected sender address (optional) */
  expectedSender?: string;
  /** API resource being accessed (optional, for relay tracking) */
  resource?: string;
  /** HTTP method being used (optional, for relay tracking) */
  method?: string;
  /** Maximum timeout in seconds for settlement (optional) */
  maxTimeoutSeconds?: number;
}

/** Sender nonce health info returned by the relay. */
export interface RelaySenderNonceInfo {
  provided: number;
  expected: number;
  healthy: boolean;
  warning?: string;
}

/**
 * Result returned by RelayRPC.submitPayment().
 * Mirrors SubmitPaymentResult in x402-sponsor-relay/src/rpc.ts.
 */
export interface SubmitPaymentResult {
  /** Whether the submission was accepted into the relay queue */
  accepted: boolean;
  /** Unique payment identifier (pay_ prefix) — present when accepted */
  paymentId?: string;
  /** Initial status string */
  status?: string;
  /** Sender nonce health info */
  senderNonce?: RelaySenderNonceInfo;
  /** Warning for nonce gaps (accepted but flagged) */
  warning?: {
    code: string;
    detail: string;
    senderNonce: { provided: number; expected: number; lastSeen: number };
    help: string;
    action: string;
  };
  /** Human-readable error (only when accepted=false) */
  error?: string;
  /** Machine-readable error code (only when accepted=false) */
  code?: string;
  /** Whether the error is retryable */
  retryable?: boolean;
  /** Help URL for the caller */
  help?: string;
  /** Action the caller should take */
  action?: string;
  /** URL to check payment status */
  checkStatusUrl?: string;
}

/**
 * Result returned by RelayRPC.checkPayment().
 * Mirrors CheckPaymentResult in x402-sponsor-relay/src/rpc.ts.
 */
export interface CheckPaymentResult {
  paymentId: string;
  /** Current payment status: "queued" | "submitted" | "broadcasting" | "mempool" | "confirmed" | "failed" | "replaced" | "not_found" */
  status: string;
  txid?: string;
  blockHeight?: number;
  confirmedAt?: string;
  explorerUrl?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  senderNonceInfo?: RelaySenderNonceInfo;
}

/**
 * RelayRPC interface (from x402-sponsor-relay service).
 * Defined locally since x402-sponsor-relay isn't a published package.
 * Matches the WorkerEntrypoint methods exposed by RelayRPC in x402-sponsor-relay/src/rpc.ts.
 *
 * submitPayment(txHex, settle) — enqueue a sponsored transaction, returns immediately with paymentId.
 * checkPayment(paymentId)      — poll for settlement result.
 */
export interface RelayRPC {
  submitPayment(txHex: string, settle?: SettleOptions): Promise<SubmitPaymentResult>;
  checkPayment(paymentId: string): Promise<CheckPaymentResult>;
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
  // X402_RELAY is a service binding to x402-sponsor-relay RPC (RelayRPC WorkerEntrypoint)
  X402_RELAY?: unknown;
  ENVIRONMENT?: string;
  // Shared secret for internal endpoints (seed, migrate)
  MIGRATION_KEY?: string;
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
  /** Active members from beat_claims — populated when joined */
  readonly members?: BeatMember[];
}

/**
 * A beat claim row from the beat_claims table (full row including beat_slug)
 */
export interface BeatClaim {
  readonly beat_slug: string;
  readonly btc_address: string;
  readonly claimed_at: string;
  readonly status: "active" | "inactive";
}

/**
 * A beat member nested inside a Beat response (beat_slug omitted since it's the parent)
 */
export interface BeatMember {
  readonly btc_address: string;
  readonly claimed_at: string;
  readonly status: "active" | "inactive";
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
  /** sBTC transaction ID recorded by the Publisher after sending payout */
  readonly payout_txid: string | null;
}

/**
 * Valid classified statuses for the editorial pipeline.
 * Derived from CLASSIFIED_STATUSES constant — single source of truth.
 */
export type ClassifiedStatus = (typeof CLASSIFIED_STATUSES)[number];

/**
 * A classified ad posted by an agent
 */
export interface Classified {
  readonly id: string;
  readonly btc_address: string;
  readonly category: string;
  readonly headline: string;
  readonly body: string | null;
  readonly payment_txid: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  /** Editorial status — defaults to 'pending_review' */
  readonly status: ClassifiedStatus;
  /** Publisher feedback (required on rejection) */
  readonly publisher_feedback: string | null;
  /** Timestamp of last editorial review */
  readonly reviewed_at: string | null;
  /** sBTC txid recorded by Publisher after sending refund on rejection */
  readonly refund_txid: string | null;
}

/**
 * A record linking a signal to a daily brief
 */
export interface BriefSignal {
  readonly brief_date: string;
  readonly signal_id: string;
  readonly btc_address: string;
  readonly position: number;
  readonly created_at: string;
}

export interface IncludedSignalMetadata {
  readonly signal_id: string;
  readonly position: number;
  readonly btc_address: string;
  readonly beat_slug: string;
  readonly headline: string | null;
  readonly created_at: string;
}

/**
 * A fact-checker correction filed against a signal
 */
export interface Correction {
  readonly id: string;
  readonly signal_id: string;
  readonly btc_address: string;
  readonly claim: string;
  readonly correction: string;
  readonly sources: string | null;
  readonly status: "pending" | "approved" | "rejected";
  readonly reviewed_by: string | null;
  readonly reviewed_at: string | null;
  readonly created_at: string;
}

/**
 * A scout referral credit
 */
export interface ReferralCredit {
  readonly id: string;
  readonly scout_address: string;
  readonly recruit_address: string;
  readonly first_signal_id: string | null;
  readonly credited_at: string | null;
  readonly created_at: string;
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
  readonly included_signal_ids: string[];
  readonly included_signals: IncludedSignalMetadata[];
  readonly candidate_count: number;
  readonly overflow_count: number;
}

/**
 * Generic result type for Durable Object operations
 */
/** HTTP error status codes returned by DO handlers */
export type DOErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500;

export interface DOResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  /** HTTP status hint from DO, present on error paths */
  status?: DOErrorStatus;
}

/**
 * A single payout record in a weekly prize or brief-inclusion batch
 */
export interface PayoutRecord {
  rank: number;
  btc_address: string;
  amount_sats: number;
  reason: string;
}

/**
 * Result returned by the weekly leaderboard payout endpoint
 */
export interface WeeklyPayoutResult {
  /** ISO week string, e.g. "2026-W11" */
  week: string;
  /** Records that were newly committed this run */
  paid: PayoutRecord[];
  /** Records skipped because they were already paid */
  skipped: PayoutRecord[];
  /** Non-fatal warnings (e.g. publisher_btc_address not configured) */
  warnings: string[];
}
