/**
 * migrate-kv-to-do.ts
 *
 * Migrates data from the old Cloudflare KV-based Pages app to the new
 * NewsDO Durable Object running on a Cloudflare Worker.
 *
 * Usage:
 *   npx tsx scripts/migrate-kv-to-do.ts [--dry-run]
 *
 * Required environment variables:
 *   OLD_CF_ACCOUNT_ID    — Cloudflare account ID for the old KV namespace
 *   OLD_CF_API_TOKEN     — Cloudflare API token with KV:Read permissions
 *   OLD_KV_NAMESPACE_ID  — KV namespace ID from the old account
 *   NEW_WORKER_URL       — Base URL for the new Worker (e.g. https://agent-news-staging.workers.dev)
 *   MIGRATION_KEY        — Shared secret matching the Worker's MIGRATION_KEY secret
 *                          (set via: wrangler secret put MIGRATION_KEY --env staging)
 *
 * Migration order (foreign key dependency order):
 *   beats → signals → signal_tags → streaks → earnings → briefs → classifieds
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");

const OLD_CF_ACCOUNT_ID = process.env.OLD_CF_ACCOUNT_ID ?? "";
const OLD_CF_API_TOKEN = process.env.OLD_CF_API_TOKEN ?? "";
const OLD_KV_NAMESPACE_ID = process.env.OLD_KV_NAMESPACE_ID ?? "";
const NEW_WORKER_URL = (process.env.NEW_WORKER_URL ?? "").replace(/\/$/, "");
const MIGRATION_KEY = process.env.MIGRATION_KEY ?? "";

function assertConfig(): void {
  const missing: string[] = [];
  if (!OLD_CF_ACCOUNT_ID) missing.push("OLD_CF_ACCOUNT_ID");
  if (!OLD_CF_API_TOKEN) missing.push("OLD_CF_API_TOKEN");
  if (!MIGRATION_KEY) missing.push("MIGRATION_KEY");
  if (!OLD_KV_NAMESPACE_ID) missing.push("OLD_KV_NAMESPACE_ID");
  if (!NEW_WORKER_URL) missing.push("NEW_WORKER_URL");
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// KV API helpers
// ---------------------------------------------------------------------------

interface KVListKey {
  name: string;
  expiration?: number;
  metadata?: unknown;
}

interface KVListResponse {
  result: KVListKey[];
  result_info: { count: number; cursor: string };
  success: boolean;
  errors: { code: number; message: string }[];
  messages: string[];
}

/**
 * Async generator that yields all KV keys matching the given prefix.
 * Handles pagination automatically.
 */
async function* kvList(
  accountId: string,
  apiToken: string,
  namespaceId: string,
  prefix: string
): AsyncGenerator<KVListKey> {
  let cursor = "";
  while (true) {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/keys`
    );
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`KV list failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as KVListResponse;

    if (!data.success) {
      throw new Error(`KV list error: ${JSON.stringify(data.errors)}`);
    }

    for (const key of data.result) {
      yield key;
    }

    // Stop when cursor is empty or fewer results than limit
    const newCursor = data.result_info?.cursor ?? "";
    if (!newCursor || data.result.length < 1000) break;
    cursor = newCursor;
  }
}

/**
 * Retrieve a single KV value by key. Returns null if missing.
 */
async function kvGet(
  accountId: string,
  apiToken: string,
  namespaceId: string,
  key: string
): Promise<unknown> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
  });

  if (res.status === 404) return null;

  if (!res.ok) {
    throw new Error(`KV get failed for key "${key}": ${res.status} ${await res.text()}`);
  }

  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Return raw string if not JSON
    return text;
  }
}

// ---------------------------------------------------------------------------
// Worker API helpers
// ---------------------------------------------------------------------------

interface MigrateResult {
  imported: number;
  skipped: number;
}

/**
 * Send a batch of records to the new Worker's /api/internal/migrate endpoint.
 */
async function sendBatch(
  type: string,
  records: Record<string, unknown>[]
): Promise<MigrateResult> {
  if (DRY_RUN) {
    console.log(`  [dry-run] Would import ${records.length} ${type} records`);
    return { imported: records.length, skipped: 0 };
  }

  const res = await fetch(`${NEW_WORKER_URL}/api/internal/migrate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Migration-Key": MIGRATION_KEY,
    },
    body: JSON.stringify({ type, records }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Migrate batch failed for ${type}: ${res.status} ${text}`);
  }

  return (await res.json()) as MigrateResult;
}

/**
 * Chunk an array into groups of at most `size`.
 */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Send all records in batches of 100, logging progress.
 */
async function migrateAll(
  type: string,
  records: Record<string, unknown>[]
): Promise<{ imported: number; skipped: number }> {
  if (records.length === 0) {
    console.log(`  No ${type} records to migrate.`);
    return { imported: 0, skipped: 0 };
  }

  const batches = chunk(records, 100);
  let totalImported = 0;
  let totalSkipped = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const result = await sendBatch(type, batch);
      totalImported += result.imported;
      totalSkipped += result.skipped;
      console.log(
        `  Batch ${i + 1}/${batches.length}: ${result.imported} imported, ${result.skipped} skipped`
      );
    } catch (err) {
      console.error(`  ERROR in batch ${i + 1}/${batches.length}:`, err);
      // Continue with next batch — some records may have been deleted from KV
    }
  }

  return { imported: totalImported, skipped: totalSkipped };
}

// ---------------------------------------------------------------------------
// Migration status check
// ---------------------------------------------------------------------------

async function printMigrationStatus(): Promise<void> {
  if (DRY_RUN) {
    console.log("[dry-run] Skipping migration status check.");
    return;
  }

  const res = await fetch(`${NEW_WORKER_URL}/api/internal/migrate/status`, {
    method: "GET",
    headers: { "X-Migration-Key": MIGRATION_KEY },
  });

  if (!res.ok) {
    console.error(`Migration status check failed: ${res.status} ${await res.text()}`);
    return;
  }

  const counts = (await res.json()) as Record<string, number>;
  console.log("\nMigration Status (DO row counts):");
  for (const [entity, count] of Object.entries(counts)) {
    console.log(`  ${entity}: ${count}`);
  }
}

// ---------------------------------------------------------------------------
// Per-entity migration functions
// ---------------------------------------------------------------------------

interface OldBeat {
  slug?: string;
  name?: string;
  description?: string | null;
  color?: string | null;
  // KV uses camelCase
  claimedBy?: string;
  claimedAt?: string;
  created_by?: string; // fallback
  created_at?: string; // fallback
  updated_at?: string;
  signature?: string;
}

interface OldSignal {
  id?: string;
  // KV uses camelCase field names
  beat?: string; // display name e.g. "DAO Watch"
  beatSlug?: string;
  beat_slug?: string; // fallback
  btcAddress?: string;
  btc_address?: string; // fallback
  address?: string; // fallback
  headline?: string;
  content?: string | null; // KV uses "content" not "body"
  body?: string | null; // fallback
  sources?: unknown;
  tags?: string[];
  timestamp?: string; // KV uses "timestamp" not "created_at"
  created_at?: string; // fallback
  updated_at?: string;
  correction_of?: string | null;
  inscriptionId?: string | null;
  signature?: string;
}

interface OldStreak {
  address?: string;
  btc_address?: string;
  // KV uses short names
  current?: number;
  longest?: number;
  lastDate?: string | null;
  history?: string[];
  // fallbacks
  current_streak?: number;
  longest_streak?: number;
  last_signal_date?: string | null;
  total_signals?: number;
}

interface OldEarning {
  id?: string;
  address?: string;
  btc_address?: string;
  amount_sats?: number;
  reason?: string;
  reference_id?: string | null;
  created_at?: string;
}

interface OldBrief {
  date?: string;
  text?: string;
  // KV uses camelCase and different names
  json?: unknown; // KV uses "json" not "json_data"
  json_data?: string | null; // fallback
  compiledAt?: string;
  compiledBy?: string;
  compiled_at?: string; // fallback
  inscription?: {
    inscriptionId?: string;
    inscribedBy?: string;
    inscribedAt?: string;
  } | null;
  inscribed_txid?: string | null; // fallback
  inscription_id?: string | null; // fallback
}

interface OldClassified {
  id?: string;
  // KV uses camelCase
  placedBy?: string;
  btc_address?: string; // fallback
  address?: string; // fallback
  category?: string;
  title?: string; // KV uses "title" not "headline"
  headline?: string; // fallback
  body?: string | null;
  contact?: string | null;
  paymentTxid?: string | null;
  payment_txid?: string | null; // fallback
  createdAt?: string;
  created_at?: string; // fallback
  expiresAt?: string;
  expires_at?: string; // fallback
}

/** Map from beat display name → slug, populated during migrateBeats(). */
const beatNameToSlug = new Map<string, string>();

async function migrateBeats(): Promise<{ kvCount: number; imported: number; skipped: number }> {
  console.log("\n[1/7] Migrating beats...");
  const records: Record<string, unknown>[] = [];
  const seenSlugs = new Set<string>();
  let kvCount = 0;

  for await (const key of kvList(OLD_CF_ACCOUNT_ID, OLD_CF_API_TOKEN, OLD_KV_NAMESPACE_ID, "beat:")) {
    // Skip index keys like beat:{slug}:signals
    const parts = key.name.split(":");
    if (parts.length !== 2) continue;

    kvCount++;
    const slug = parts[1];
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);

    try {
      const value = await kvGet(OLD_CF_ACCOUNT_ID, OLD_CF_API_TOKEN, OLD_KV_NAMESPACE_ID, key.name);
      if (!value || typeof value !== "object") continue;

      const beat = value as OldBeat;
      const now = new Date().toISOString();
      const beatSlug = beat.slug ?? slug;
      const beatName = beat.name ?? slug;

      // Build name→slug lookup for use during signal migration
      beatNameToSlug.set(beatName, beatSlug);
      beatNameToSlug.set(beatName.toLowerCase(), beatSlug);

      records.push({
        slug: beatSlug,
        name: beatName,
        description: beat.description ?? null,
        color: beat.color ?? null,
        created_by: beat.claimedBy ?? beat.created_by ?? "migration",
        created_at: beat.claimedAt ?? beat.created_at ?? now,
        updated_at: beat.updated_at ?? beat.claimedAt ?? now,
      });
    } catch (err) {
      console.error(`  Failed to fetch beat:${slug}:`, err);
    }
  }

  console.log(`  Found ${kvCount} beat keys, prepared ${records.length} records.`);
  console.log(`  Built name→slug map with ${beatNameToSlug.size} entries.`);
  const result = await migrateAll("beats", records);
  return { kvCount, ...result };
}

async function migrateSignals(): Promise<{
  kvCount: number;
  imported: number;
  skipped: number;
  signalTagRecords: Record<string, unknown>[];
}> {
  console.log("\n[2/7] Migrating signals...");
  const signalRecords: Record<string, unknown>[] = [];
  const signalTagRecords: Record<string, unknown>[] = [];
  let kvCount = 0;

  for await (const key of kvList(OLD_CF_ACCOUNT_ID, OLD_CF_API_TOKEN, OLD_KV_NAMESPACE_ID, "signal:")) {
    // Skip index keys (e.g. signal:{id}:tags — unlikely but guard anyway)
    const parts = key.name.split(":");
    if (parts.length !== 2) continue;

    kvCount++;
    const id = parts[1];

    try {
      const value = await kvGet(OLD_CF_ACCOUNT_ID, OLD_CF_API_TOKEN, OLD_KV_NAMESPACE_ID, key.name);
      if (!value || typeof value !== "object") continue;

      const signal = value as OldSignal;
      const now = new Date().toISOString();

      const signalId = signal.id ?? id;
      // KV uses camelCase: beatSlug or beat (display name) — resolve to slug
      const rawBeat = signal.beatSlug ?? signal.beat_slug ?? signal.beat ?? "";
      const beatSlug =
        beatNameToSlug.get(rawBeat) ??
        beatNameToSlug.get(rawBeat.toLowerCase()) ??
        rawBeat;
      // KV uses camelCase: btcAddress
      const btcAddress = signal.btcAddress ?? signal.btc_address ?? signal.address ?? "";

      const sourcesJson = signal.sources
        ? typeof signal.sources === "string"
          ? signal.sources
          : JSON.stringify(signal.sources)
        : "[]";

      // KV uses "content" not "body", "timestamp" not "created_at"
      signalRecords.push({
        id: signalId,
        beat_slug: beatSlug,
        btc_address: btcAddress,
        headline: signal.headline ?? "",
        body: signal.content ?? signal.body ?? null,
        sources: sourcesJson,
        created_at: signal.timestamp ?? signal.created_at ?? now,
        updated_at: signal.updated_at ?? signal.timestamp ?? now,
        correction_of: signal.correction_of ?? null,
      });

      // Collect signal_tags from inline tags array
      const tags = Array.isArray(signal.tags) ? signal.tags : [];
      for (const tag of tags) {
        if (typeof tag === "string" && tag.trim()) {
          signalTagRecords.push({ signal_id: signalId, tag: tag.trim() });
        }
      }
    } catch (err) {
      console.error(`  Failed to fetch signal:${id}:`, err);
    }
  }

  console.log(`  Found ${kvCount} signal keys, prepared ${signalRecords.length} signal records, ${signalTagRecords.length} tag records.`);
  const result = await migrateAll("signals", signalRecords);
  return { kvCount, ...result, signalTagRecords };
}

async function migrateSignalTags(
  signalTagRecords: Record<string, unknown>[]
): Promise<{ kvCount: number; imported: number; skipped: number }> {
  console.log("\n[3/7] Migrating signal_tags...");
  console.log(`  Prepared ${signalTagRecords.length} tag records from signals.`);
  const result = await migrateAll("signal_tags", signalTagRecords);
  return { kvCount: signalTagRecords.length, ...result };
}

async function migrateStreaks(): Promise<{ kvCount: number; imported: number; skipped: number }> {
  console.log("\n[4/7] Migrating streaks...");
  const records: Record<string, unknown>[] = [];
  let kvCount = 0;

  for await (const key of kvList(OLD_CF_ACCOUNT_ID, OLD_CF_API_TOKEN, OLD_KV_NAMESPACE_ID, "streak:")) {
    const parts = key.name.split(":");
    if (parts.length !== 2) continue;

    kvCount++;
    const address = parts[1];

    try {
      const value = await kvGet(OLD_CF_ACCOUNT_ID, OLD_CF_API_TOKEN, OLD_KV_NAMESPACE_ID, key.name);
      if (!value || typeof value !== "object") continue;

      const streak = value as OldStreak;
      records.push({
        btc_address: streak.btc_address ?? streak.address ?? address,
        current_streak: streak.current ?? streak.current_streak ?? 0,
        longest_streak: streak.longest ?? streak.longest_streak ?? 0,
        last_signal_date: streak.lastDate ?? streak.last_signal_date ?? null,
        total_signals: streak.history?.length ?? streak.total_signals ?? 0,
      });
    } catch (err) {
      console.error(`  Failed to fetch streak:${address}:`, err);
    }
  }

  console.log(`  Found ${kvCount} streak keys, prepared ${records.length} records.`);
  const result = await migrateAll("streaks", records);
  return { kvCount, ...result };
}

async function migrateEarnings(): Promise<{ kvCount: number; imported: number; skipped: number }> {
  console.log("\n[5/7] Migrating earnings...");
  const records: Record<string, unknown>[] = [];
  let kvCount = 0;

  for await (const key of kvList(OLD_CF_ACCOUNT_ID, OLD_CF_API_TOKEN, OLD_KV_NAMESPACE_ID, "earning:")) {
    const parts = key.name.split(":");
    if (parts.length !== 2) continue;

    kvCount++;
    const id = parts[1];

    try {
      const value = await kvGet(OLD_CF_ACCOUNT_ID, OLD_CF_API_TOKEN, OLD_KV_NAMESPACE_ID, key.name);
      if (!value || typeof value !== "object") continue;

      const earning = value as OldEarning;
      const now = new Date().toISOString();
      records.push({
        id: earning.id ?? id,
        btc_address: earning.btc_address ?? earning.address ?? "",
        amount_sats: earning.amount_sats ?? 0,
        reason: earning.reason ?? "migration",
        reference_id: earning.reference_id ?? null,
        created_at: earning.created_at ?? now,
      });
    } catch (err) {
      console.error(`  Failed to fetch earning:${id}:`, err);
    }
  }

  console.log(`  Found ${kvCount} earning keys, prepared ${records.length} records.`);
  const result = await migrateAll("earnings", records);
  return { kvCount, ...result };
}

async function migrateBriefs(): Promise<{ kvCount: number; imported: number; skipped: number }> {
  console.log("\n[6/7] Migrating briefs...");
  const records: Record<string, unknown>[] = [];
  let kvCount = 0;

  for await (const key of kvList(OLD_CF_ACCOUNT_ID, OLD_CF_API_TOKEN, OLD_KV_NAMESPACE_ID, "brief:")) {
    const parts = key.name.split(":");
    // brief:YYYY-MM-DD has format "brief:2024-01-15" which splits into 2 parts
    // but the date contains hyphens, so we need to rejoin after "brief:"
    if (parts.length < 2) continue;

    kvCount++;
    const date = parts.slice(1).join(":");

    try {
      const value = await kvGet(OLD_CF_ACCOUNT_ID, OLD_CF_API_TOKEN, OLD_KV_NAMESPACE_ID, key.name);
      if (!value || typeof value !== "object") continue;

      const brief = value as OldBrief;
      const now = new Date().toISOString();

      // If text is not directly on the object, it might be nested
      const text = brief.text ?? (typeof value === "object" ? JSON.stringify(value) : String(value));

      // KV "json" field is an object — serialize to string for json_data column
      const jsonData = brief.json
        ? typeof brief.json === "string"
          ? brief.json
          : JSON.stringify(brief.json)
        : brief.json_data ?? null;

      records.push({
        date: brief.date ?? date,
        text,
        json_data: jsonData,
        compiled_at: brief.compiledAt ?? brief.compiled_at ?? now,
        inscribed_txid: brief.inscribed_txid ?? null,
        inscription_id: brief.inscription?.inscriptionId ?? brief.inscription_id ?? null,
      });
    } catch (err) {
      console.error(`  Failed to fetch brief:${date}:`, err);
    }
  }

  console.log(`  Found ${kvCount} brief keys, prepared ${records.length} records.`);
  const result = await migrateAll("briefs", records);
  return { kvCount, ...result };
}

async function migrateClassifieds(): Promise<{ kvCount: number; imported: number; skipped: number }> {
  console.log("\n[7/7] Migrating classifieds...");
  const records: Record<string, unknown>[] = [];
  let kvCount = 0;

  for await (const key of kvList(OLD_CF_ACCOUNT_ID, OLD_CF_API_TOKEN, OLD_KV_NAMESPACE_ID, "classified:")) {
    const parts = key.name.split(":");
    if (parts.length !== 2) continue;

    kvCount++;
    const id = parts[1];

    try {
      const value = await kvGet(OLD_CF_ACCOUNT_ID, OLD_CF_API_TOKEN, OLD_KV_NAMESPACE_ID, key.name);
      if (!value || typeof value !== "object") continue;

      const classified = value as OldClassified;
      const now = new Date().toISOString();
      records.push({
        id: classified.id ?? id,
        btc_address: classified.placedBy ?? classified.btc_address ?? classified.address ?? "",
        category: classified.category ?? "general",
        headline: classified.title ?? classified.headline ?? "",
        body: classified.body ?? null,
        contact: classified.contact ?? null,
        payment_txid: classified.paymentTxid ?? classified.payment_txid ?? null,
        created_at: classified.createdAt ?? classified.created_at ?? now,
        expires_at: classified.expiresAt ?? classified.expires_at ?? now,
      });
    } catch (err) {
      console.error(`  Failed to fetch classified:${id}:`, err);
    }
  }

  console.log(`  Found ${kvCount} classified keys, prepared ${records.length} records.`);
  const result = await migrateAll("classifieds", records);
  return { kvCount, ...result };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (DRY_RUN) {
    console.log("=== DRY RUN MODE — no data will be written to the DO ===\n");
  }

  assertConfig();

  console.log("Starting KV → DO migration...");
  console.log(`  Source KV namespace: ${OLD_KV_NAMESPACE_ID}`);
  console.log(`  Target Worker:       ${NEW_WORKER_URL}`);

  const summary: Record<string, { kvCount: number; imported: number; skipped: number }> = {};

  // 1. Beats (no dependencies)
  const beatsResult = await migrateBeats();
  summary.beats = beatsResult;

  // 2. Signals (depends on beats) + collect signal_tags
  const signalsResult = await migrateSignals();
  summary.signals = { kvCount: signalsResult.kvCount, imported: signalsResult.imported, skipped: signalsResult.skipped };

  // 3. signal_tags (depends on signals)
  const signalTagsResult = await migrateSignalTags(signalsResult.signalTagRecords);
  summary.signal_tags = signalTagsResult;

  // 4. Streaks (independent)
  const streaksResult = await migrateStreaks();
  summary.streaks = streaksResult;

  // 5. Earnings (independent)
  const earningsResult = await migrateEarnings();
  summary.earnings = earningsResult;

  // 6. Briefs (independent)
  const briefsResult = await migrateBriefs();
  summary.briefs = briefsResult;

  // 7. Classifieds (independent)
  const classifiedsResult = await migrateClassifieds();
  summary.classifieds = classifiedsResult;

  // Summary table
  console.log("\n=== Migration Summary ===");
  console.log("Entity       | KV Keys | Imported | Skipped");
  console.log("-------------|---------|----------|--------");
  for (const [entity, stats] of Object.entries(summary)) {
    const e = entity.padEnd(12);
    const kv = String(stats.kvCount).padStart(7);
    const imp = String(stats.imported).padStart(8);
    const skip = String(stats.skipped).padStart(7);
    console.log(`${e} | ${kv} | ${imp} | ${skip}`);
  }

  // Final status from DO
  await printMigrationStatus();

  console.log("\nMigration complete.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
