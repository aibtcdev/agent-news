// Bounty Board — KV-backed, free to create
// GET  /api/bounties — list bounties with filters
// POST /api/bounties — create a bounty (BIP-322 signature auth, free)

import {
  CORS, json, err, options, methodNotAllowed,
  BOUNTY_MAX_TITLE, BOUNTY_MAX_DESCRIPTION, BOUNTY_MAX_TAGS, BOUNTY_STATUSES,
  validateBtcAddress, validateSignatureFormat, validateSlug,
  sanitizeString, checkIPRateLimit,
} from './_shared.js';

const MAX_INDEX_SIZE = 1000;

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method === 'GET') return handleGet(context);
  if (context.request.method === 'POST') return handlePost(context);
  return methodNotAllowed();
}

// ── GET /api/bounties ──

async function handleGet(context) {
  const kv = context.env.SIGNAL_KV;
  const url = new URL(context.request.url);
  const statusFilter = url.searchParams.get('status');
  const beatFilter = url.searchParams.get('beat');
  const skillsParam = url.searchParams.get('skills');
  const sort = url.searchParams.get('sort') || 'newest';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);

  // Validate status filter
  if (statusFilter && !BOUNTY_STATUSES.includes(statusFilter)) {
    return err(`Invalid status. Must be one of: ${BOUNTY_STATUSES.join(', ')}`);
  }

  // Parse skills filter
  const skillsFilter = skillsParam
    ? skillsParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : null;

  const index = (await kv.get('bounties:index', 'json')) || [];

  // Fetch all matching bounties (for sorting and pagination)
  const matching = [];
  for (const id of index) {
    const bounty = await kv.get(`bounty:${id}`, 'json');
    if (!bounty) continue;
    if (statusFilter && bounty.status !== statusFilter) continue;
    if (beatFilter && bounty.beatSlug !== beatFilter) continue;
    if (skillsFilter && skillsFilter.length > 0) {
      const bountySkills = (bounty.skills || []).map(s => s.toLowerCase());
      const hasMatch = skillsFilter.some(s => bountySkills.includes(s));
      if (!hasMatch) continue;
    }
    matching.push(bounty);
  }

  // Sort
  if (sort === 'amount_high') {
    matching.sort((a, b) => b.amountSats - a.amountSats);
  } else if (sort === 'amount_low') {
    matching.sort((a, b) => a.amountSats - b.amountSats);
  }
  // 'newest' is already insertion order (most recent first)

  const page = matching.slice(offset, offset + limit);

  return json({
    bounties: page,
    total: matching.length,
    offset,
    limit,
  }, { cache: 15 });
}

// ── POST /api/bounties ──

async function handlePost(context) {
  const kv = context.env.SIGNAL_KV;

  // IP rate limit: 5/hour
  const rlErr = await checkIPRateLimit(kv, context.request, {
    key: 'bounties', maxRequests: 5, windowSeconds: 3600,
  });
  if (rlErr) return rlErr;

  let body;
  try {
    body = await context.request.json();
  } catch {
    return err('Invalid JSON body');
  }

  const {
    btcAddress,
    creatorName,
    title,
    description,
    amountSats,
    tags,
    skills,
    beatSlug,
    deadline,
    signature,
    timestamp,
  } = body;

  // Required field checks
  if (!btcAddress || !title || !description || amountSats === undefined || !signature || !timestamp) {
    return err('Missing required fields: btcAddress, title, description, amountSats, signature, timestamp');
  }

  // Validate BTC address
  if (!validateBtcAddress(btcAddress)) {
    return err('Invalid BTC address format (expected bech32 bc1...)');
  }

  // Validate signature format
  if (!validateSignatureFormat(signature)) {
    return err('Invalid signature format (expected base64, 20-200 chars)', 401);
  }

  // Validate timestamp (ISO 8601, must be within last 5 minutes)
  const ts = new Date(timestamp).getTime();
  if (isNaN(ts)) {
    return err('Invalid timestamp (expected ISO 8601)');
  }
  const ageDiffMs = Math.abs(Date.now() - ts);
  if (ageDiffMs > 5 * 60 * 1000) {
    return err('Timestamp too old or too far in future (must be within 5 minutes)');
  }

  // Validate title
  const cleanTitle = sanitizeString(title, BOUNTY_MAX_TITLE);
  if (cleanTitle.length < 5) {
    return err(`Title too short (min 5 chars, max ${BOUNTY_MAX_TITLE})`);
  }

  // Validate description
  const cleanDescription = sanitizeString(description, BOUNTY_MAX_DESCRIPTION);
  if (cleanDescription.length < 10) {
    return err(`Description too short (min 10 chars, max ${BOUNTY_MAX_DESCRIPTION})`);
  }

  // Validate amountSats
  if (typeof amountSats !== 'number' || !Number.isInteger(amountSats) || amountSats < 1000) {
    return err('amountSats must be an integer >= 1000');
  }

  // Validate optional tags array
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.length > 10) {
      return err('tags must be an array of up to 10 strings');
    }
    for (const t of tags) {
      if (typeof t !== 'string' || t.length === 0 || t.length > 50) {
        return err('Each tag must be a non-empty string up to 50 chars');
      }
    }
  }

  // Validate optional skills array
  if (skills !== undefined) {
    if (!Array.isArray(skills) || skills.length > 10) {
      return err('skills must be an array of up to 10 strings');
    }
    for (const s of skills) {
      if (typeof s !== 'string' || s.length === 0 || s.length > 50) {
        return err('Each skill must be a non-empty string up to 50 chars');
      }
    }
  }

  // Validate optional beatSlug
  if (beatSlug !== undefined && beatSlug !== null && beatSlug !== '') {
    const slug = beatSlug.toLowerCase();
    if (!validateSlug(slug)) {
      return err('Invalid beatSlug (a-z0-9 + hyphens, 3-50 chars)');
    }
  }

  // Validate optional deadline (must be in the future)
  if (deadline !== undefined && deadline !== null) {
    const dl = new Date(deadline).getTime();
    if (isNaN(dl)) {
      return err('Invalid deadline (expected ISO 8601)');
    }
    if (dl <= Date.now()) {
      return err('deadline must be in the future');
    }
  }

  // Build and store bounty
  const bounty = await storeBounty(kv, {
    creatorBtc: btcAddress,
    creatorName: creatorName ? sanitizeString(creatorName, 100) : null,
    title: cleanTitle,
    description: cleanDescription,
    amountSats,
    tags: tags ? tags.map(t => sanitizeString(t, 50)) : [],
    skills: skills ? skills.map(s => sanitizeString(s, 50)) : [],
    beatSlug: beatSlug ? beatSlug.toLowerCase() : null,
    deadline: deadline ? new Date(deadline).toISOString() : null,
    signature,
  });

  return json({ ok: true, bounty }, { status: 201 });
}

// ── Helper: store bounty in KV ──

async function storeBounty(kv, data) {
  const now = new Date();

  // Generate UUID-style ID using time + random
  const id = `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 6)}`;

  const bounty = {
    id,
    creatorBtc: data.creatorBtc,
    creatorName: data.creatorName || null,
    title: data.title,
    description: data.description,
    amountSats: data.amountSats,
    tags: data.tags,
    skills: data.skills,
    beatSlug: data.beatSlug || null,
    status: 'open',
    deadline: data.deadline || null,
    claimCount: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  // Store individual bounty
  await kv.put(`bounty:${id}`, JSON.stringify(bounty));

  // Prepend to global index
  const index = (await kv.get('bounties:index', 'json')) || [];
  index.unshift(id);
  if (index.length > MAX_INDEX_SIZE) index.length = MAX_INDEX_SIZE;
  await kv.put('bounties:index', JSON.stringify(index));

  // Prepend to creator index
  const creatorBounties = (await kv.get(`bounties:creator:${data.creatorBtc}`, 'json')) || [];
  creatorBounties.unshift(id);
  if (creatorBounties.length > 100) creatorBounties.length = 100;
  await kv.put(`bounties:creator:${data.creatorBtc}`, JSON.stringify(creatorBounties));

  // Prepend to beat index if beatSlug provided
  if (data.beatSlug) {
    const beatBounties = (await kv.get(`bounties:beat:${data.beatSlug}`, 'json')) || [];
    beatBounties.unshift(id);
    if (beatBounties.length > 200) beatBounties.length = 200;
    await kv.put(`bounties:beat:${data.beatSlug}`, JSON.stringify(beatBounties));
  }

  return bounty;
}
