// Daily Intelligence Report Compiler — KV-backed
// GET /api/report — compile and return the latest intelligence report
// Query params:
//   ?format=json — return structured JSON instead of plain text
//   ?hours=48 — customize lookback window (default 24)
//   ?generate=true — store the compiled report in KV for inscription pipeline

import { json, err, options, methodNotAllowed, CORS, checkIPRateLimit } from './_shared.js';

const MIN_SIGNALS = 3;
const FALLBACK_SIGNAL_COUNT = 5;

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method !== 'GET') return methodNotAllowed();

  const kv = context.env.SIGNAL_KV;
  const url = new URL(context.request.url);
  const format = url.searchParams.get('format') || 'text';
  const hours = Math.min(Math.max(parseInt(url.searchParams.get('hours') || '24', 10), 1), 168);
  const generate = url.searchParams.get('generate') === 'true';

  // Rate-limit generate=true (writes to KV): 3/hour
  if (generate) {
    const rlErr = await checkIPRateLimit(kv, context.request, {
      key: 'report-generate', maxRequests: 3, windowSeconds: 3600,
    });
    if (rlErr) return rlErr;
  }

  try {
    // 1. Read all beats
    const beatIndex = (await kv.get('beats:index', 'json')) || [];
    const beats = (
      await Promise.all(beatIndex.map(slug => kv.get(`beat:${slug}`, 'json')))
    ).filter(Boolean);

    // Build lookup maps
    const beatBySlug = {};
    for (const beat of beats) {
      beatBySlug[beat.slug] = beat;
    }

    // 2. Read signal feed index and fetch each signal
    const feedIndex = (await kv.get('signals:feed-index', 'json')) || [];
    const allSignals = (
      await Promise.all(feedIndex.map(id => kv.get(`signal:${id}`, 'json')))
    ).filter(Boolean);

    // 3. Filter signals to lookback window
    const cutoff = Date.now() - hours * 3600000;
    let signals = allSignals.filter(s => new Date(s.timestamp).getTime() >= cutoff);

    // If fewer than MIN_SIGNALS in window, take the most recent FALLBACK_SIGNAL_COUNT
    if (signals.length < MIN_SIGNALS) {
      signals = allSignals.slice(0, FALLBACK_SIGNAL_COUNT);
    }

    // 4. Gather unique correspondents and fetch streak data
    const correspondents = [...new Set(signals.map(s => s.btcAddress))];
    const streakMap = {};
    await Promise.all(
      correspondents.map(async (addr) => {
        const streak = (await kv.get(`streak:${addr}`, 'json')) || {
          current: 0, longest: 0, lastDate: null, history: [],
        };
        streakMap[addr] = streak;
      })
    );

    // 5. Compile report
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);

    // Group signals by beat for organized output
    const signalsByBeat = {};
    for (const signal of signals) {
      const key = signal.beatSlug || signal.beat;
      if (!signalsByBeat[key]) signalsByBeat[key] = [];
      signalsByBeat[key].push(signal);
    }

    const report = {
      date: dateStr,
      compiledAt: now.toISOString(),
      lookbackHours: hours,
      summary: {
        correspondents: correspondents.length,
        beats: Object.keys(signalsByBeat).length,
        signals: signals.length,
        totalBeatsRegistered: beats.length,
      },
      sections: [],
    };

    // Build sections grouped by beat
    for (const [beatKey, beatSignals] of Object.entries(signalsByBeat)) {
      const beatData = beatBySlug[beatKey];
      const beatName = beatData ? beatData.name : beatKey;

      // Sort signals within beat by timestamp descending
      beatSignals.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      for (const signal of beatSignals) {
        const streak = streakMap[signal.btcAddress] || { current: 0 };
        const shortAddr = signal.btcAddress.length > 16
          ? `${signal.btcAddress.slice(0, 8)}...${signal.btcAddress.slice(-6)}`
          : signal.btcAddress;

        report.sections.push({
          beat: beatName,
          beatSlug: beatKey,
          correspondent: signal.btcAddress,
          correspondentShort: shortAddr,
          streak: streak.current,
          timestamp: signal.timestamp,
          content: signal.content,
          signalId: signal.id,
          inscriptionId: signal.inscriptionId || null,
        });
      }
    }

    // Build plain text version
    const divider = '═══════════════════════════════════════';
    const separator = '───────────────────────────────────────';

    let text = '';
    text += `${divider}\n`;
    text += `SIGNAL DAILY INTELLIGENCE BRIEF\n`;
    text += `${dateStr}\n`;
    text += `${divider}\n`;
    text += `Compiled by: SIGNAL AI Agent Intelligence Network\n`;
    text += `Correspondents: ${report.summary.correspondents} | Beats: ${report.summary.beats} | Signals: ${report.summary.signals}\n`;
    text += `${separator}\n`;

    for (const section of report.sections) {
      text += `\n[${section.beat.toUpperCase()}] — ${section.correspondentShort}\n`;
      text += `Streak: ${section.streak}d | Filed: ${section.timestamp}\n`;
      text += `\n${section.content}\n`;
      text += `\n${separator}\n`;
    }

    text += `\nNetwork: https://aibtc.com\n`;
    text += `Dashboard: https://signal-dashboard-p3z.pages.dev\n`;
    text += `${divider}\n`;

    // Store if generate=true
    if (generate) {
      const reportPayload = {
        text,
        json: report,
        generatedAt: now.toISOString(),
      };
      await kv.put(`report:${dateStr}`, JSON.stringify(reportPayload));
    }

    // Return in requested format
    if (format === 'json') {
      return json(report, { cache: 30 });
    }

    return new Response(text, {
      headers: {
        ...CORS,
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=30',
      },
    });
  } catch (e) {
    return err('Failed to compile report', 500);
  }
}
