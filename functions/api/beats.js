// Signal Beat Registry — KV-backed
// GET /api/beats — list all beats
// POST /api/beats — claim a beat (requires btcAddress + signature)

import {
  CORS, json, err, options, methodNotAllowed,
  validateBtcAddress, validateSlug, validateHexColor,
  validateSignatureFormat, sanitizeString, checkIPRateLimit,
} from './_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method === 'GET') return handleGet(context);
  if (context.request.method === 'POST') return handlePost(context);
  if (context.request.method === 'PATCH') return handlePatch(context);
  return methodNotAllowed();
}

async function handleGet(context) {
  const kv = context.env.SIGNAL_KV;
  const index = await kv.get('beats:index', 'json');
  const beats = index || [];

  // Fetch full beat data for each
  const results = await Promise.all(
    beats.map(async (slug) => {
      const beat = await kv.get(`beat:${slug}`, 'json');
      return beat;
    })
  );

  return json(results.filter(Boolean), { cache: 15 });
}

async function handlePost(context) {
  const kv = context.env.SIGNAL_KV;

  // IP rate limit: 5/hour
  const rlErr = await checkIPRateLimit(kv, context.request, {
    key: 'beats', maxRequests: 5, windowSeconds: 3600,
  });
  if (rlErr) return rlErr;

  let body;
  try {
    body = await context.request.json();
  } catch {
    return err('Invalid JSON body');
  }

  const { btcAddress, name, slug, description, color, signature } = body;

  if (!btcAddress || !name || !slug) {
    return err('Missing required fields: btcAddress, name, slug');
  }

  if (!validateBtcAddress(btcAddress)) {
    return err('Invalid BTC address format (expected bech32 bc1...)');
  }

  if (!validateSlug(slug)) {
    return err('Invalid slug (a-z0-9 + hyphens, 3-50 chars)');
  }

  if (color && !validateHexColor(color)) {
    return err('Invalid color format (expected #RRGGBB)');
  }

  if (!signature) {
    return err('Missing signature. Sign: "SIGNAL|claim-beat|{slug}|{btcAddress}"', 401);
  }

  if (!validateSignatureFormat(signature)) {
    return err('Invalid signature format (expected base64, 20-200 chars)', 401);
  }

  // Check if beat already claimed
  const existing = await kv.get(`beat:${slug}`, 'json');
  if (existing) {
    return err(`Beat "${slug}" is already claimed by ${existing.claimedBy}`, 409);
  }

  const beat = {
    slug,
    name: sanitizeString(name, 100),
    description: sanitizeString(description || '', 500),
    color: color || '#22d3ee',
    claimedBy: btcAddress,
    claimedAt: new Date().toISOString(),
    signature,
  };

  // Store beat
  await kv.put(`beat:${slug}`, JSON.stringify(beat));

  // Update index
  const index = (await kv.get('beats:index', 'json')) || [];
  if (!index.includes(slug)) {
    index.push(slug);
    await kv.put('beats:index', JSON.stringify(index));
  }

  return json({ ok: true, beat }, { status: 201 });
}

// PATCH /api/beats — update a beat (only the claimant can update, requires signature)
async function handlePatch(context) {
  const kv = context.env.SIGNAL_KV;

  let body;
  try {
    body = await context.request.json();
  } catch {
    return err('Invalid JSON body');
  }

  const { btcAddress, slug, signature } = body;

  if (!btcAddress || !slug || !signature) {
    return err('Missing required fields: btcAddress, slug, signature');
  }

  if (!validateBtcAddress(btcAddress)) {
    return err('Invalid BTC address format (expected bech32 bc1...)');
  }

  if (!validateSignatureFormat(signature)) {
    return err('Invalid signature format (expected base64, 20-200 chars)', 401);
  }

  const existing = await kv.get(`beat:${slug}`, 'json');
  if (!existing) {
    return err(`Beat "${slug}" not found`, 404);
  }

  if (existing.claimedBy !== btcAddress) {
    return err('Only the claimant can update this beat', 403);
  }

  // Update allowed fields
  const updated = { ...existing };
  if (body.description !== undefined) updated.description = sanitizeString(body.description, 500);
  if (body.color !== undefined) {
    if (!validateHexColor(body.color)) return err('Invalid color format (expected #RRGGBB)');
    updated.color = body.color;
  }
  updated.signature = signature;
  updated.updatedAt = new Date().toISOString();

  await kv.put(`beat:${slug}`, JSON.stringify(updated));

  return json({ ok: true, beat: updated });
}
