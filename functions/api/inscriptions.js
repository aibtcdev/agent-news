// Proxy to inscribe.news API, returns recent news inscriptions

import { json, err, options, methodNotAllowed } from './_shared.js';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const limit = parseInt(url.searchParams.get('limit') || '10', 10);

  try {
    const res = await fetch('https://inscribe.news/api/data/ord-news');
    const raw = await res.json();

    // Response format: { list_complete: true, keys: [{name, metadata: {id, number, ...}}, ...] }
    const keys = raw.keys || [];

    const entries = keys
      .filter(entry => entry && entry.metadata)
      .map(entry => ({
        name: entry.name,
        ...entry.metadata
      }));

    // Sort by inscription number descending (most recent first)
    entries.sort((a, b) => (b.number || 0) - (a.number || 0));

    return json(entries.slice(0, limit), { cache: 300 });
  } catch {
    return err('Failed to fetch inscriptions', 502);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method === 'GET') return onRequestGet(context);
  return methodNotAllowed();
}
