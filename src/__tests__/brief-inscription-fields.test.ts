import { describe, it, expect } from "vitest";
import { SELF, env } from "cloudflare:test";
import { saveBrief, updateBrief } from "../lib/do-client";
import type { Env } from "../lib/types";

// `cloudflare:test` types env as Cloudflare.Env; the do-client helpers want the
// app's own Env. Same cast the other DO-touching suites use.
const testEnv = env as unknown as Env;

/**
 * /api/brief and /api/brief/:date must expose flat, snake_case inscription_id /
 * inscribed_txid fields read straight from the DB column — the same shape the
 * /api/brief/:date/inscription endpoint returns.
 *
 * Before this, inscription state on the brief endpoints was only reachable at
 * the nested camelCase `.inscription.inscriptionId` path, while the compile-time
 * `json_data` blob carried no flat field at all. A client polling
 * `.inscription_id` therefore got a *permanent* undefined — not a value that
 * lagged and cleared, but one that never existed. That was misread as a
 * 5-minute edge-cache staleness (#870 investigation), when in fact
 * /api/brief/:date is not edge-cached at all and the data was always fresh.
 */
async function seedBrief(date: string, updates?: { inscription_id: string; inscribed_txid: string }) {
  const saved = await saveBrief(testEnv, {
    date,
    text: "brief body",
    json_data: JSON.stringify({ sections: [], summary: { beats: 0, signals: 0, correspondents: 0 } }),
    compiled_at: `${date}T01:00:00.000Z`,
  });
  expect(saved.ok).toBe(true);
  if (updates) {
    const updated = await updateBrief(testEnv, date, updates);
    expect(updated.ok).toBe(true);
  }
}

describe("/api/brief/:date — flat inscription fields", () => {
  it("mirrors the DB column into flat inscription_id/inscribed_txid after inscription", async () => {
    const date = "2026-06-10";
    const inscriptionId = `${"a".repeat(64)}i0`;
    const inscribedTxid = "b".repeat(64);
    await seedBrief(date, { inscription_id: inscriptionId, inscribed_txid: inscribedTxid });

    const res = await SELF.fetch(`http://example.com/api/brief/${date}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // Flat fields — the canonical shape agents poll (matches /inscription).
    expect(body.inscription_id).toBe(inscriptionId);
    expect(body.inscribed_txid).toBe(inscribedTxid);
    // Nested object kept for backward-compat with the frontend.
    expect(body.inscription).toMatchObject({ inscriptionId, inscribedTxid });
  });

  it("emits flat inscription fields as null (present, never undefined) before inscription", async () => {
    const date = "2026-06-11";
    await seedBrief(date);

    const res = await SELF.fetch(`http://example.com/api/brief/${date}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // The keys must exist so a client polling `.inscription_id` reads a real
    // null, not undefined — the false-negative that started #870.
    expect(body).toHaveProperty("inscription_id");
    expect(body.inscription_id).toBeNull();
    expect(body).toHaveProperty("inscribed_txid");
    expect(body.inscribed_txid).toBeNull();
  });
});
