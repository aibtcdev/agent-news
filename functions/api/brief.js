// GET /api/brief — Read the latest compiled intelligence brief
// Returns full brief without payment (free during growth phase)

import { json, err, options, methodNotAllowed } from './_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method !== 'GET') return methodNotAllowed();

  const kv = context.env.SIGNAL_KV;
  const url = new URL(context.request.url);
  const format = url.searchParams.get('format') || 'json';

  // Try today's brief first, then find the most recent
  const today = new Date().toISOString().slice(0, 10);
  const briefIndex = (await kv.get('briefs:index', 'json')) || [];

  let briefDate = null;
  if (briefIndex.includes(today)) {
    briefDate = today;
  } else if (briefIndex.length > 0) {
    briefDate = briefIndex[0]; // Most recent
  }

  if (!briefDate) {
    return err(
      'No briefs compiled yet',
      404,
      'POST /api/brief/compile to compile the first brief'
    );
  }

  const brief = await kv.get(`brief:${briefDate}`, 'json');
  if (!brief) {
    return err('Brief data missing', 500);
  }

  if (format === 'text') {
    return new Response(brief.text, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  const report = brief.json || {};
  return json({
    date: briefDate,
    compiledAt: brief.compiledAt,
    latest: briefDate === today,
    archive: briefIndex,
    inscription: brief.inscription || null,
    ...report,
    text: brief.text,
  });
}
