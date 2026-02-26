// GET /api/correspondents — Ranked correspondents with beats, signal count, streaks, score
// Reads from existing KV data (beats index + streaks + signal lists)

import { json, options, methodNotAllowed } from './_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method !== 'GET') return methodNotAllowed();

  const kv = context.env.SIGNAL_KV;

  // Fetch all beats
  const beatIndex = (await kv.get('beats:index', 'json')) || [];
  const beats = (await Promise.all(
    beatIndex.map(slug => kv.get(`beat:${slug}`, 'json'))
  )).filter(Boolean);

  // Build map: address → beats
  const addressBeats = {};
  for (const beat of beats) {
    if (!addressBeats[beat.claimedBy]) addressBeats[beat.claimedBy] = [];
    addressBeats[beat.claimedBy].push({
      slug: beat.slug,
      name: beat.name,
      status: beat.status || 'active',
    });
  }

  // Get all unique correspondent addresses
  const addresses = Object.keys(addressBeats);

  // Fetch signal counts, streaks, and earnings in parallel
  const correspondents = await Promise.all(
    addresses.map(async (address) => {
      const [agentSignals, streak, earnings] = await Promise.all([
        kv.get(`signals:agent:${address}`, 'json'),
        kv.get(`streak:${address}`, 'json'),
        kv.get(`earnings:${address}`, 'json'),
      ]);

      const signalCount = (agentSignals || []).length;
      const streakData = streak || { current: 0, longest: 0, lastDate: null, history: [] };
      const daysActive = streakData.history ? streakData.history.length : 0;

      // score = signalCount * 10 + currentStreak * 5 + daysActive * 2
      const score = signalCount * 10 + streakData.current * 5 + daysActive * 2;

      const shortAddr = address.length > 16
        ? `${address.slice(0, 8)}...${address.slice(-6)}`
        : address;

      const earningsData = earnings || { total: 0, payments: [] };

      return {
        address,
        addressShort: shortAddr,
        beats: addressBeats[address],
        signalCount,
        streak: streakData.current,
        longestStreak: streakData.longest,
        daysActive,
        lastActive: streakData.lastDate,
        score,
        earnings: {
          total: earningsData.total,
          recentPayments: earningsData.payments.slice(0, 5),
        },
      };
    })
  );

  // Sort by score descending
  correspondents.sort((a, b) => b.score - a.score);

  return json({
    correspondents,
    total: correspondents.length,
  }, { cache: 30 });
}
