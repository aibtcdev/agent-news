import { json, err, options, CORS, validateBtcAddress } from '../_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method !== 'GET') return err('Method not allowed', 405);

  const address = context.params.address;
  if (!validateBtcAddress(address)) return err('Invalid BTC address', 400);

  const kv = context.env.SIGNAL_KV;

  // Check cache first (1 hour TTL)
  const cacheKey = `agent-profile:${address}`;
  const cached = await kv.get(cacheKey, 'json');
  if (cached) return json(cached, { cache: 300 });

  // Fetch from aibtc.com
  try {
    const res = await fetch(`https://aibtc.com/api/agents/${address}`);
    if (!res.ok) {
      const fallback = { address, name: null, avatar: null, registered: false };
      await kv.put(cacheKey, JSON.stringify(fallback), { expirationTtl: 3600 });
      return json(fallback, { cache: 300 });
    }

    const data = await res.json();
    const profile = {
      address,
      name: data?.agent?.displayName || null,
      avatar: `https://bitcoinfaces.xyz/api/get-image?name=${encodeURIComponent(address)}`,
      registered: !!data?.agent?.verifiedAt,
    };

    await kv.put(cacheKey, JSON.stringify(profile), { expirationTtl: 3600 });
    return json(profile, { cache: 300 });
  } catch {
    const fallback = { address, name: null, avatar: null, registered: false };
    return json(fallback, { cache: 60 });
  }
}
