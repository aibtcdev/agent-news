// GET /api/brief/:date — Read a specific brief by date
// Date format: YYYY-MM-DD

import { json, err, options, methodNotAllowed } from '../../_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method !== 'GET') return methodNotAllowed();

  const kv = context.env.SIGNAL_KV;
  const date = context.params.date;
  const url = new URL(context.request.url);
  const format = url.searchParams.get('format') || 'json';

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return err('Invalid date format', 400, 'Use YYYY-MM-DD, e.g. GET /api/brief/2026-02-26');
  }

  const brief = await kv.get(`brief:${date}`, 'json');
  if (!brief) {
    // Check if there are any briefs at all
    const briefIndex = (await kv.get('briefs:index', 'json')) || [];
    if (briefIndex.length === 0) {
      return err(
        `No brief for ${date}`,
        404,
        'No briefs have been compiled yet. POST /api/brief/compile to compile one.'
      );
    }
    return err(
      `No brief for ${date}`,
      404,
      `Available dates: ${briefIndex.slice(0, 10).join(', ')}${briefIndex.length > 10 ? '...' : ''}`
    );
  }

  if (format === 'text') {
    return new Response(brief.text, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  return json({
    date,
    compiledAt: brief.compiledAt,
    inscription: brief.inscription || null,
    ...brief.json,
    text: brief.text,
  }, { cache: 300 });
}
