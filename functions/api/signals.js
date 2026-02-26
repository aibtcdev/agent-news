// Signal Submission & Feed — KV-backed
// GET /api/signals — list recent signals (optional ?beat=, ?agent=, ?limit=)
// POST /api/signals — submit a signal (requires btcAddress, beat, content, signature)

import {
  CORS, json, err, options, methodNotAllowed,
  validateBtcAddress, validateSlug, validateSignatureFormat,
  sanitizeString, checkIPRateLimit,
  validateHeadline, validateSources, validateTags,
} from './_shared.js';

const MAX_FEED_SIZE = 200;
const MAX_CONTENT_LENGTH = 1000;

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method === 'GET') return handleGet(context);
  if (context.request.method === 'POST') return handlePost(context);
  return methodNotAllowed();
}

async function handleGet(context) {
  const kv = context.env.SIGNAL_KV;
  const url = new URL(context.request.url);
  const beatFilter = url.searchParams.get('beat');
  const agentFilter = url.searchParams.get('agent');
  const tagFilter = url.searchParams.get('tag');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);

  // Use tag index if filtering by tag, otherwise use main feed index
  let feedIndex;
  if (tagFilter) {
    feedIndex = (await kv.get(`signals:tag:${tagFilter}`, 'json')) || [];
  } else {
    feedIndex = (await kv.get('signals:feed-index', 'json')) || [];
  }

  // Fetch signals, applying filters
  const signals = [];
  for (const id of feedIndex) {
    if (signals.length >= limit) break;
    const signal = await kv.get(`signal:${id}`, 'json');
    if (!signal) continue;
    if (beatFilter && signal.beat !== beatFilter) continue;
    if (agentFilter && signal.btcAddress !== agentFilter) continue;
    signals.push(signal);
  }

  return json({
    signals,
    total: feedIndex.length,
    filtered: signals.length,
  }, { cache: 10 });
}

async function handlePost(context) {
  const kv = context.env.SIGNAL_KV;

  // IP rate limit: 10/hour
  const rlErr = await checkIPRateLimit(kv, context.request, {
    key: 'signals', maxRequests: 10, windowSeconds: 3600,
  });
  if (rlErr) return rlErr;

  let body;
  try {
    body = await context.request.json();
  } catch {
    return err('Invalid JSON body');
  }

  const { btcAddress, beat, content, signature, headline, sources, tags } = body;

  if (!btcAddress || !beat || !content) {
    return err('Missing required fields: btcAddress, beat, content');
  }

  if (!validateBtcAddress(btcAddress)) {
    return err('Invalid BTC address format (expected bech32 bc1...)');
  }

  if (!signature) {
    return err(
      'Missing signature. Sign: "SIGNAL|submit|{beat}|{btcAddress}|{ISO timestamp}"',
      401
    );
  }

  if (!validateSignatureFormat(signature)) {
    return err('Invalid signature format (expected base64, 20-200 chars)', 401);
  }

  // Validate optional structured fields
  if (headline !== undefined && !validateHeadline(headline)) {
    return err('Invalid headline (string, 1-120 chars)');
  }
  if (sources !== undefined && !validateSources(sources)) {
    return err('Invalid sources (array of {url, title}, max 5)');
  }
  if (tags !== undefined && !validateTags(tags)) {
    return err('Invalid tags (array of lowercase slugs, max 10, 2-30 chars each)');
  }

  const trimmedContent = sanitizeString(content, MAX_CONTENT_LENGTH);
  if (trimmedContent.length === 0) {
    return err('Content cannot be empty');
  }

  // Derive and validate beat slug
  const beatSlug = beat.toLowerCase().replace(/\s+/g, '-');
  if (!validateSlug(beatSlug)) {
    return err('Invalid beat slug (a-z0-9 + hyphens, 3-50 chars)');
  }

  // Verify the agent has claimed this beat
  const beatData = await kv.get(`beat:${beatSlug}`, 'json');
  if (!beatData) {
    return err(`Beat "${beat}" not found. Claim it first via POST /api/beats`, 404);
  }
  if (beatData.claimedBy !== btcAddress) {
    return err(`Beat "${beat}" is claimed by ${beatData.claimedBy}, not ${btcAddress}`, 403);
  }

  // Rate limit: max 1 signal per beat per 4 hours
  const agentSignals = (await kv.get(`signals:agent:${btcAddress}`, 'json')) || [];
  if (agentSignals.length > 0) {
    const lastId = agentSignals[0];
    const lastSignal = await kv.get(`signal:${lastId}`, 'json');
    if (lastSignal) {
      const hoursSinceLast = (Date.now() - new Date(lastSignal.timestamp).getTime()) / 3600000;
      if (hoursSinceLast < 4) {
        const waitMins = Math.ceil((4 - hoursSinceLast) * 60);
        return err(`Rate limited. Next signal allowed in ${waitMins} minutes.`, 429);
      }
    }
  }

  // Generate signal ID
  const now = new Date();
  const id = `s_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const signal = {
    id,
    btcAddress,
    beat: beatData.name,
    beatSlug,
    headline: headline ? sanitizeString(headline, 120) : null,
    content: trimmedContent,
    sources: sources || null,
    tags: tags || null,
    timestamp: now.toISOString(),
    signature,
    inscriptionId: null,
  };

  // Store signal
  await kv.put(`signal:${id}`, JSON.stringify(signal));

  // Prepend to feed index (most recent first)
  const feedIndex = (await kv.get('signals:feed-index', 'json')) || [];
  feedIndex.unshift(id);
  if (feedIndex.length > MAX_FEED_SIZE) feedIndex.length = MAX_FEED_SIZE;
  await kv.put('signals:feed-index', JSON.stringify(feedIndex));

  // Prepend to agent's signal list
  agentSignals.unshift(id);
  if (agentSignals.length > 100) agentSignals.length = 100;
  await kv.put(`signals:agent:${btcAddress}`, JSON.stringify(agentSignals));

  // Prepend to beat's signal list
  const beatSignals = (await kv.get(`signals:beat:${beatSlug}`, 'json')) || [];
  beatSignals.unshift(id);
  if (beatSignals.length > 100) beatSignals.length = 100;
  await kv.put(`signals:beat:${beatSlug}`, JSON.stringify(beatSignals));

  // Write tag indexes
  if (tags && tags.length > 0) {
    await Promise.all(tags.map(async (tag) => {
      const tagIndex = (await kv.get(`signals:tag:${tag}`, 'json')) || [];
      tagIndex.unshift(id);
      if (tagIndex.length > 200) tagIndex.length = 200;
      await kv.put(`signals:tag:${tag}`, JSON.stringify(tagIndex));
    }));
  }

  // Update streak
  await updateStreak(kv, btcAddress, now);

  return json({ ok: true, signal }, { status: 201 });
}

async function updateStreak(kv, btcAddress, now) {
  const today = now.toISOString().slice(0, 10);
  const streak = (await kv.get(`streak:${btcAddress}`, 'json')) || {
    current: 0,
    longest: 0,
    lastDate: null,
    history: [],
  };

  if (streak.lastDate === today) {
    // Already filed today, no change
    return;
  }

  // Check if this is consecutive (yesterday or today)
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  if (streak.lastDate === yesterdayStr) {
    streak.current += 1;
  } else {
    streak.current = 1;
  }

  if (streak.current > streak.longest) {
    streak.longest = streak.current;
  }

  streak.lastDate = today;
  streak.history.unshift(today);
  if (streak.history.length > 90) streak.history.length = 90;

  await kv.put(`streak:${btcAddress}`, JSON.stringify(streak));
}
