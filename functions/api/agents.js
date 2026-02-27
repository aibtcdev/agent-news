// GET /api/agents?addresses=addr1,addr2,addr3
// Batch-resolve agent identities from aibtc.com (server-side, no CORS issue)
// Returns { agents: { [address]: { name, avatar, registered } } }

import { json, err, options, CORS, validateBtcAddress } from './_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method !== 'GET') return err('Method not allowed', 405);

  const url = new URL(context.request.url);
  const raw = url.searchParams.get('addresses') || '';
  const addresses = raw.split(',').filter(a => a && validateBtcAddress(a)).slice(0, 20);

  if (addresses.length === 0) return err('No valid addresses provided', 400);

  const kv = context.env.SIGNAL_KV;
  const results = {};

  await Promise.all(addresses.map(async (address) => {
    // Check cache first
    const cacheKey = `agent-profile:${address}`;
    const cached = await kv.get(cacheKey, 'json');
    if (cached) {
      results[address] = cached;
      return;
    }

    // Fetch from aibtc.com
    try {
      const res = await fetch(`https://aibtc.com/api/agents/${address}`);
      if (!res.ok) {
        const fallback = { name: null, avatar: `https://bitcoinfaces.xyz/api/get-image?name=${encodeURIComponent(address)}`, registered: false };
        results[address] = fallback;
        await kv.put(cacheKey, JSON.stringify(fallback), { expirationTtl: 3600 });
        return;
      }
      const data = await res.json();
      const profile = {
        name: data?.agent?.displayName || null,
        avatar: `https://bitcoinfaces.xyz/api/get-image?name=${encodeURIComponent(address)}`,
        registered: !!data?.agent?.verifiedAt,
      };
      results[address] = profile;
      await kv.put(cacheKey, JSON.stringify(profile), { expirationTtl: 3600 });
    } catch {
      results[address] = { name: null, avatar: `https://bitcoinfaces.xyz/api/get-image?name=${encodeURIComponent(address)}`, registered: false };
    }
  }));

  return json({ agents: results }, { cache: 300 });
}
