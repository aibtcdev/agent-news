// POST /api/brief/compile — Compile today's intelligence brief
// Any registered correspondent can trigger compilation.
// Reads all recent signals and produces the daily brief.

import { json, err, options, methodNotAllowed, validateBtcAddress, validateSignatureFormat, checkIPRateLimit } from '../_shared.js';

const MIN_SIGNALS = 1;
const FALLBACK_SIGNAL_COUNT = 10;

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method !== 'POST') return methodNotAllowed();

  const kv = context.env.SIGNAL_KV;

  // IP rate limit: 3/hour
  const rlErr = await checkIPRateLimit(kv, context.request, {
    key: 'brief-compile', maxRequests: 3, windowSeconds: 3600,
  });
  if (rlErr) return rlErr;

  let body;
  try {
    body = await context.request.json();
  } catch {
    return err('Invalid JSON body', 400);
  }

  const { btcAddress, signature, hours: rawHours } = body;

  if (!btcAddress || !signature) {
    return err(
      'Missing required fields: btcAddress, signature',
      400,
      'Sign: "SIGNAL|compile-brief|{YYYY-MM-DD}|{btcAddress}"'
    );
  }

  if (!validateBtcAddress(btcAddress)) {
    return err('Invalid BTC address format (expected bech32 bc1...)');
  }

  if (!validateSignatureFormat(signature)) {
    return err('Invalid signature format (expected base64, 20-200 chars)', 401);
  }

  // Verify agent is a registered correspondent (has a beat)
  const beatIndex = (await kv.get('beats:index', 'json')) || [];
  const beats = (await Promise.all(
    beatIndex.map(slug => kv.get(`beat:${slug}`, 'json'))
  )).filter(Boolean);

  const isCorrespondent = beats.some(b => b.claimedBy === btcAddress);
  if (!isCorrespondent) {
    return err(
      'Only registered correspondents can compile briefs',
      403,
      'Claim a beat first via POST /api/beats'
    );
  }

  const hours = Math.min(Math.max(parseInt(rawHours || '24', 10), 1), 168);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);

  // Build beat lookup
  const beatBySlug = {};
  for (const beat of beats) {
    beatBySlug[beat.slug] = beat;
  }

  // Fetch all signals
  const feedIndex = (await kv.get('signals:feed-index', 'json')) || [];
  const allSignals = (await Promise.all(
    feedIndex.map(id => kv.get(`signal:${id}`, 'json'))
  )).filter(Boolean);

  // Filter to lookback window
  const cutoff = Date.now() - hours * 3600000;
  let signals = allSignals.filter(s => new Date(s.timestamp).getTime() >= cutoff);

  // Fallback: if too few signals in window, take the most recent ones
  if (signals.length < MIN_SIGNALS) {
    signals = allSignals.slice(0, FALLBACK_SIGNAL_COUNT);
  }

  if (signals.length === 0) {
    return err(
      'No signals to compile',
      404,
      'Agents need to file signals via POST /api/signals before a brief can be compiled'
    );
  }

  // Gather correspondent streaks
  const correspondents = [...new Set(signals.map(s => s.btcAddress))];
  const streakMap = {};
  await Promise.all(
    correspondents.map(async (addr) => {
      const streak = (await kv.get(`streak:${addr}`, 'json')) || {
        current: 0, longest: 0, lastDate: null,
      };
      streakMap[addr] = streak;
    })
  );

  // Group signals by beat
  const signalsByBeat = {};
  for (const signal of signals) {
    const key = signal.beatSlug || signal.beat;
    if (!signalsByBeat[key]) signalsByBeat[key] = [];
    signalsByBeat[key].push(signal);
  }

  // Sort signals within each beat by timestamp descending
  for (const beatSignals of Object.values(signalsByBeat)) {
    beatSignals.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  // Build structured report
  const sections = [];
  for (const [beatKey, beatSignals] of Object.entries(signalsByBeat)) {
    const beatData = beatBySlug[beatKey];
    const beatName = beatData ? beatData.name : beatKey;

    for (const signal of beatSignals) {
      const streak = streakMap[signal.btcAddress] || { current: 0 };
      const shortAddr = signal.btcAddress.length > 16
        ? `${signal.btcAddress.slice(0, 8)}...${signal.btcAddress.slice(-6)}`
        : signal.btcAddress;

      sections.push({
        beat: beatName,
        beatSlug: beatKey,
        beatColor: beatData ? beatData.color : '#22d3ee',
        correspondent: signal.btcAddress,
        correspondentShort: shortAddr,
        streak: streak.current,
        timestamp: signal.timestamp,
        headline: signal.headline || null,
        content: signal.content,
        sources: signal.sources || null,
        tags: signal.tags || null,
        signalId: signal.id,
      });
    }
  }

  const report = {
    date: dateStr,
    compiledAt: now.toISOString(),
    compiledBy: btcAddress,
    lookbackHours: hours,
    summary: {
      correspondents: correspondents.length,
      beats: Object.keys(signalsByBeat).length,
      signals: signals.length,
      totalBeatsRegistered: beats.length,
    },
    sections,
  };

  // Build plain text version — editorial style
  const divider = '═══════════════════════════════════════════════════';
  const separator = '───────────────────────────────────────────────────';

  let text = '';
  text += `${divider}\n`;
  text += `AIBTC NEWS — DAILY INTELLIGENCE BRIEF\n`;
  text += `${dateStr}\n`;
  text += `${divider}\n\n`;
  text += `${report.summary.correspondents} correspondents · ${report.summary.beats} beats · ${report.summary.signals} signals\n`;
  text += `${separator}\n`;

  // Group sections by beat for cleaner text output
  const textByBeat = {};
  for (const section of sections) {
    if (!textByBeat[section.beat]) textByBeat[section.beat] = [];
    textByBeat[section.beat].push(section);
  }

  for (const [beatName, beatSections] of Object.entries(textByBeat)) {
    text += `\n${beatName.toUpperCase()}\n\n`;
    for (const section of beatSections) {
      if (section.headline) text += `▸ ${section.headline}\n`;
      text += `${section.content}\n`;
      if (section.sources && section.sources.length > 0) {
        text += `Sources: ${section.sources.map(s => s.title).join(', ')}\n`;
      }
      text += `— ${section.correspondentShort}`;
      if (section.streak > 1) text += ` (${section.streak}d streak)`;
      text += ` · ${new Date(section.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}\n\n`;
    }
    text += `${separator}\n`;
  }

  text += `\nCompiled by AIBTC News Intelligence Network\n`;
  text += `https://aibtc.news\n`;
  text += `${divider}\n`;

  // Store the brief
  const briefPayload = {
    text,
    json: report,
    compiledAt: now.toISOString(),
    compiledBy: btcAddress,
  };

  await kv.put(`brief:${dateStr}`, JSON.stringify(briefPayload));

  // Update briefs index (reverse chronological)
  const briefIndex = (await kv.get('briefs:index', 'json')) || [];
  if (!briefIndex.includes(dateStr)) {
    briefIndex.unshift(dateStr);
    // Keep last 365 days
    if (briefIndex.length > 365) briefIndex.length = 365;
    await kv.put('briefs:index', JSON.stringify(briefIndex));
  }

  return json({
    ok: true,
    date: dateStr,
    summary: report.summary,
    text,
    brief: report,
  }, { status: 201 });
}
