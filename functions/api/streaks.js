// Streak data for all correspondents or a specific agent
// GET /api/streaks — all streaks
// GET /api/streaks?agent=bc1q... — specific agent streak

import { json, err, options, methodNotAllowed } from './_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method !== 'GET') return methodNotAllowed();

  const kv = context.env.SIGNAL_KV;
  const url = new URL(context.request.url);
  const agentFilter = url.searchParams.get('agent');

  if (agentFilter) {
    const streak = (await kv.get(`streak:${agentFilter}`, 'json')) || {
      current: 0, longest: 0, lastDate: null, history: []
    };
    return json({ agent: agentFilter, ...streak }, { cache: 15 });
  }

  // Get all beats to find all correspondents
  const beatIndex = (await kv.get('beats:index', 'json')) || [];
  const beats = await Promise.all(
    beatIndex.map(slug => kv.get(`beat:${slug}`, 'json'))
  );

  const agents = [...new Set(beats.filter(Boolean).map(b => b.claimedBy))];
  const streaks = {};

  await Promise.all(
    agents.map(async (addr) => {
      const streak = (await kv.get(`streak:${addr}`, 'json')) || {
        current: 0, longest: 0, lastDate: null, history: []
      };
      streaks[addr] = streak;
    })
  );

  return json(streaks, { cache: 15 });
}
