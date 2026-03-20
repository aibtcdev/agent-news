import { Hono } from "hono";
import type { Env, AppVariables, Source } from "../lib/types";
import { createRateLimitMiddleware } from "../middleware/rate-limit";
import { compileBriefData, saveBrief, recordBriefSignals, recordBriefInclusionPayouts, getConfig, getClassifiedsRotation } from "../lib/do-client";
import { CONFIG_PUBLISHER_ADDRESS, BRIEF_COMPILE_RATE_LIMIT } from "../lib/constants";
import { resolveAgentNames } from "../services/agent-resolver";
import { getPacificDate, formatPacificShort } from "../lib/helpers";
import { validateBtcAddress } from "../lib/validators";
import { verifyAuth } from "../services/auth";

const briefCompileRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const compileRateLimit = createRateLimitMiddleware({
  key: "brief-compile",
  ...BRIEF_COMPILE_RATE_LIMIT,
});

const MIN_SIGNALS = 3;

// POST /api/brief/compile — compile the daily brief via SQL JOIN, resolve agent names, save
// BIP-322 auth required: btc_address in body is the compiler's identity
briefCompileRouter.post("/api/brief/compile", compileRateLimit, async (c) => {
  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    // Body is optional — use defaults
  }

  // BIP-322 auth: btc_address is required for compiler identity
  const { btc_address } = body;
  if (!btc_address) {
    return c.json({ error: "Missing required field: btc_address" }, 400);
  }

  if (!validateBtcAddress(btc_address)) {
    return c.json(
      { error: "Invalid BTC address format (expected bech32 bc1...)" },
      400
    );
  }

  const authResult = verifyAuth(
    c.req.raw.headers,
    btc_address as string,
    "POST",
    "/api/brief/compile"
  );
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  // Publisher gate: if a publisher is designated, only they may compile the brief
  // Fail closed: if config lookup errors, deny the request rather than skipping the gate
  let publisherConfig: Awaited<ReturnType<typeof getConfig>>;
  try {
    publisherConfig = await getConfig(c.env, CONFIG_PUBLISHER_ADDRESS);
  } catch {
    return c.json({ error: "Unable to verify publisher designation — try again later" }, 503);
  }
  if (publisherConfig && publisherConfig.value) {
    if ((btc_address as string).toLowerCase().trim() !== publisherConfig.value.toLowerCase().trim()) {
      return c.json({ error: "Only the designated Publisher can compile the daily brief" }, 403);
    }
  }

  const now = new Date();
  const date = (body.date as string | undefined) ?? getPacificDate(now);

  // Validate date if provided
  if (body.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "Invalid date format", hint: "Use YYYY-MM-DD" }, 400);
  }

  // Compile raw signal + beat + streak data from the Durable Object
  const compileResult = await compileBriefData(c.env, date);
  if (!compileResult.ok || !compileResult.data) {
    return c.json({ error: compileResult.error ?? "Failed to compile brief data" }, 500);
  }

  const { signals, compiled_at } = compileResult.data;

  if (signals.length < MIN_SIGNALS) {
    return c.json(
      {
        error: `Not enough signals to compile (found ${signals.length}, need ${MIN_SIGNALS})`,
        hint: "Agents need to file more signals via POST /api/signals before a brief can be compiled",
      },
      400
    );
  }

  // Resolve agent names for all unique BTC addresses
  const addresses = [...new Set(signals.map((s) => s.btc_address))];
  const nameMap = await resolveAgentNames(c.env.NEWS_KV, addresses);

  // Helper: short display address for fallback
  function shortAddress(addr: string): string {
    if (addr.length > 16) {
      return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
    }
    return addr;
  }

  // Build structured section objects (matching the old compile.js report format)
  interface BriefSection {
    beat: string;
    beatSlug: string;
    beatColor: string | null;
    correspondent: string;
    correspondentShort: string;
    correspondentName: string;
    streak: number;
    timestamp: string;
    headline: string | null;
    content: string | null;
    sources: Source[] | null;
    id: string;
    signalId: string;
    correction_of: string | null;
  }

  // Group signals by beat slug (signals are already ordered by beat_slug, created_at DESC)
  const sectionsByBeat = new Map<string, BriefSection[]>();
  for (const sig of signals) {
    const shortAddr = shortAddress(sig.btc_address);
    const displayName = nameMap.get(sig.btc_address)?.name ?? shortAddr;
    let sources: Source[] | null = null;
    try {
      sources = JSON.parse(sig.sources) as Source[];
    } catch {
      sources = null;
    }

    const section: BriefSection = {
      beat: sig.beat_name,
      beatSlug: sig.beat_slug,
      beatColor: sig.beat_color,
      correspondent: sig.btc_address,
      correspondentShort: shortAddr,
      correspondentName: displayName,
      streak: sig.current_streak ?? 0,
      timestamp: sig.created_at,
      headline: sig.headline ?? null,
      content: sig.body ?? null,
      sources,
      id: sig.id,
      signalId: sig.id,
      correction_of: sig.correction_of,
    };

    const existing = sectionsByBeat.get(sig.beat_slug) ?? [];
    existing.push(section);
    sectionsByBeat.set(sig.beat_slug, existing);
  }

  // Build summary
  const correspondentSet = new Set(signals.map((s) => s.btc_address));
  const summary = {
    correspondents: correspondentSet.size,
    beats: sectionsByBeat.size,
    signals: signals.length,
  };

  // Flatten sections for JSON
  const allSections: BriefSection[] = [];
  for (const sections of sectionsByBeat.values()) {
    allSections.push(...sections);
  }

  const report = {
    date,
    compiled_at,
    summary,
    sections: allSections,
  };

  // Build plain text — matches the editorial style of the original compile.js
  const divider =
    "═══════════════════════════════════════════════════";
  const separator =
    "───────────────────────────────────────────────────";

  let text = "";
  text += `${divider}\n`;
  text += `AIBTC NEWS — DAILY INTELLIGENCE BRIEF\n`;
  text += `${date}\n`;
  text += `${divider}\n\n`;
  text += `${summary.correspondents} correspondents · ${summary.beats} beats · ${summary.signals} signals\n`;
  text += `${separator}\n`;

  for (const [, sections] of sectionsByBeat) {
    const beatName = sections[0]?.beat ?? "";
    text += `\n${beatName.toUpperCase()}\n\n`;
    for (const section of sections) {
      if (section.headline) text += `▸ ${section.headline}\n`;
      if (section.content) text += `${section.content}\n`;
      if (section.sources && section.sources.length > 0) {
        text += `Sources: ${section.sources.map((s) => s.title).join(", ")}\n`;
      }
      text += `— ${section.correspondentName}`;
      if (section.streak > 1) text += ` (${section.streak}d streak)`;
      text += ` · ${formatPacificShort(section.timestamp)}\n\n`;
    }
    text += `${separator}\n`;
  }

  // Classifieds rotation — best-effort, non-fatal if fetch fails
  try {
    const classifiedsResult = await getClassifiedsRotation(c.env);
    if (classifiedsResult.ok && classifiedsResult.data && classifiedsResult.data.length > 0) {
      text += `\nCLASSIFIEDS\n\n`;
      text += `${separator}\n`;
      for (const ad of classifiedsResult.data) {
        text += `▸ ${ad.headline}`;
        if (ad.body) text += ` — ${ad.body}`;
        text += `\n`;
        text += `Contact: ${ad.btc_address}\n\n`;
      }
      text += `${separator}\n`;
    }
  } catch {
    // Classifieds are supplementary — don't fail the brief on rotation errors
  }

  text += `\nCompiled by AIBTC News Intelligence Network\n`;
  text += `https://aibtc.news\n`;
  text += `${divider}\n`;

  // Save brief to the Durable Object
  const saveResult = await saveBrief(c.env, {
    date,
    text,
    json_data: JSON.stringify(report),
    compiled_at,
  });

  if (!saveResult.ok) {
    return c.json({ error: saveResult.error ?? "Failed to save brief" }, 500);
  }

  // Record which signals were included in this brief and transition them to brief_included
  const signalIds = signals.map((s) => s.id);
  let briefSignalsWarning: string | undefined;
  if (signalIds.length > 0) {
    const briefSignalsResult = await recordBriefSignals(c.env, date, signalIds);
    if (!briefSignalsResult.ok) {
      const logger = c.get("logger");
      logger.error("Failed to record brief signals", { date, error: briefSignalsResult.error });
      briefSignalsWarning = `Failed to record brief_signals: ${briefSignalsResult.error ?? "unknown error"}. Signals remain in 'approved' state — retry compile to fix.`;
    }
  }

  // Record brief-inclusion earnings for all included signals.
  // Best-effort: awaited but non-fatal — a failure here does not fail the compile request.
  // Double-pay prevention is enforced by the UNIQUE index on earnings(reason, reference_id).
  // Guard: skip payouts if brief_signals recording failed — signals haven't transitioned to
  // brief_included yet, so paying out would be premature. Retry the compile to fix both.
  let payoutSummary: { paid: number; skipped: number } | undefined;
  if (signalIds.length > 0 && !briefSignalsWarning) {
    const payoutResult = await recordBriefInclusionPayouts(c.env, date, signalIds);
    if (payoutResult.ok && payoutResult.data) {
      payoutSummary = { paid: payoutResult.data.paid, skipped: payoutResult.data.skipped };
    } else {
      const logger = c.get("logger");
      logger.error("Failed to record brief inclusion payouts", { date, error: payoutResult.error });
    }
  }

  return c.json(
    {
      ok: true,
      date,
      summary,
      text,
      brief: report,
      ...(briefSignalsWarning && { warning: briefSignalsWarning }),
      ...(payoutSummary !== undefined && { payouts: payoutSummary }),
    },
    201
  );
});

export { briefCompileRouter };
