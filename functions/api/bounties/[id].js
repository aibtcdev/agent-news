// GET /api/bounties/:id — single bounty with claims array

import { json, err, options } from '../_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method !== 'GET') return err('Method not allowed', 405);

  const kv = context.env.SIGNAL_KV;
  const id = context.params.id;

  // Basic ID safety check (allow the time-based format we generate)
  if (!id || typeof id !== 'string' || id.length > 120 || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return err('Invalid bounty ID format', 400);
  }

  const bounty = await kv.get(`bounty:${id}`, 'json');
  if (!bounty) {
    return err('Bounty not found', 404);
  }

  // Attach claims array
  const claims = (await kv.get(`bounty:${id}:claims`, 'json')) || [];
  const result = { ...bounty, claims };

  return json(result, { cache: 30 });
}
