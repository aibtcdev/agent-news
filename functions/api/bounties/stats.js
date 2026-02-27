// GET /api/bounties/stats — aggregate bounty stats

import { json, err, options, BOUNTY_STATUSES } from '../_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method !== 'GET') return err('Method not allowed', 405);

  const kv = context.env.SIGNAL_KV;
  const index = (await kv.get('bounties:index', 'json')) || [];

  // Initialize counts for every status
  const counts = {};
  for (const s of BOUNTY_STATUSES) counts[s] = 0;

  let totalSats = 0;
  let openSats = 0;

  for (const id of index) {
    const bounty = await kv.get(`bounty:${id}`, 'json');
    if (!bounty) continue;
    if (counts[bounty.status] !== undefined) counts[bounty.status]++;
    totalSats += bounty.amountSats || 0;
    if (bounty.status === 'open') openSats += bounty.amountSats || 0;
  }

  return json({
    total: index.length,
    ...counts,
    totalSats,
    openSats,
  }, { cache: 30 });
}
