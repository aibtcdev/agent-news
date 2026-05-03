#!/usr/bin/env tsx
/**
 * Drift check / repair for the materialised `correspondent_stats` table.
 *
 * Calls POST /api/config/recon-correspondents on the target deployment.
 * The endpoint is BIP-322-gated (Publisher-only); pre-signed auth headers
 * must be provided via env so this script stays signing-agnostic.
 *
 * Required env:
 *   BASE_URL              — e.g. https://aibtc.news (or staging URL)
 *   BTC_ADDRESS           — Publisher BTC address
 *   BTC_SIGNATURE         — BIP-322 signature for "POST /api/config/recon-correspondents" challenge
 *   BTC_TIMESTAMP         — ISO timestamp used in the signed challenge
 *
 * Optional flags:
 *   --repair              — recompute drifted rows in place (default: report only)
 *
 * Usage:
 *   BASE_URL=https://aibtc.news \
 *   BTC_ADDRESS=bc1q... \
 *   BTC_SIGNATURE=... \
 *   BTC_TIMESTAMP=2026-05-03T12:00:00Z \
 *   npm run recon:correspondents -- --repair
 */

const REPAIR = process.argv.includes("--repair");

const baseUrl = process.env.BASE_URL;
const btcAddress = process.env.BTC_ADDRESS;
const btcSignature = process.env.BTC_SIGNATURE;
const btcTimestamp = process.env.BTC_TIMESTAMP;

if (!baseUrl || !btcAddress || !btcSignature || !btcTimestamp) {
  console.error(
    "Missing required env: BASE_URL, BTC_ADDRESS, BTC_SIGNATURE, BTC_TIMESTAMP"
  );
  process.exit(2);
}

const url = `${baseUrl.replace(/\/$/, "")}/api/config/recon-correspondents`;

async function main() {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BTC-Address": btcAddress!,
      "X-BTC-Signature": btcSignature!,
      "X-BTC-Timestamp": btcTimestamp!,
    },
    body: JSON.stringify({ btc_address: btcAddress, repair: REPAIR }),
  });

  const json = (await res.json()) as {
    ok?: boolean;
    error?: string;
    data?: {
      expected_rows: number;
      actual_rows: number;
      drift_count: number;
      drift: Array<{ btc_address: string; field: string; expected: unknown; actual: unknown }>;
      repaired: number;
    };
  };

  if (!res.ok || !json.ok || !json.data) {
    console.error(`Recon failed (${res.status}): ${JSON.stringify(json)}`);
    process.exit(1);
  }

  const { expected_rows, actual_rows, drift_count, drift, repaired } = json.data;
  console.log(`expected_rows: ${expected_rows}`);
  console.log(`actual_rows:   ${actual_rows}`);
  console.log(`drift_count:   ${drift_count}`);
  console.log(`repaired:      ${repaired}`);

  if (drift_count > 0) {
    console.log("\nDrift entries:");
    for (const d of drift) {
      console.log(
        `  ${d.btc_address.slice(0, 12)}…  ${d.field}: expected=${JSON.stringify(d.expected)} actual=${JSON.stringify(d.actual)}`
      );
    }
  }

  process.exit(drift_count === 0 ? 0 : REPAIR && repaired === drift_count ? 0 : 3);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
