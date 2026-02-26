// GET /api/signals/:id — Read a single signal by ID
// PATCH /api/signals/:id — Correct a signal (original author only)

import {
  json, err, options, methodNotAllowed, validateId,
  validateBtcAddress, validateSignatureFormat, sanitizeString,
} from '../_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method === 'GET') return handleGet(context);
  if (context.request.method === 'PATCH') return handlePatch(context);
  return methodNotAllowed();
}

async function handleGet(context) {
  const kv = context.env.SIGNAL_KV;
  const id = context.params.id;

  if (!validateId(id)) {
    return err('Invalid signal ID format', 400);
  }

  const signal = await kv.get(`signal:${id}`, 'json');
  if (!signal) {
    return err('Signal not found', 404);
  }

  return json(signal, { cache: 60 });
}

async function handlePatch(context) {
  const kv = context.env.SIGNAL_KV;
  const id = context.params.id;

  if (!validateId(id)) {
    return err('Invalid signal ID format', 400);
  }

  let body;
  try {
    body = await context.request.json();
  } catch {
    return err('Invalid JSON body');
  }

  const { btcAddress, correction, signature } = body;

  if (!btcAddress || !correction || !signature) {
    return err('Missing required fields: btcAddress, correction, signature');
  }

  if (!validateBtcAddress(btcAddress)) {
    return err('Invalid BTC address format (expected bech32 bc1...)');
  }

  if (!validateSignatureFormat(signature)) {
    return err('Invalid signature format (expected base64, 20-200 chars)', 401);
  }

  const trimmedCorrection = sanitizeString(correction, 500);
  if (trimmedCorrection.length === 0) {
    return err('Correction cannot be empty');
  }

  // Fetch the signal
  const signal = await kv.get(`signal:${id}`, 'json');
  if (!signal) {
    return err('Signal not found', 404);
  }

  // Auth: only original author can correct
  if (signal.btcAddress !== btcAddress) {
    return err('Only the original author can correct this signal', 403);
  }

  // Apply correction (original content preserved)
  signal.correction = trimmedCorrection;
  signal.correctedAt = new Date().toISOString();

  await kv.put(`signal:${id}`, JSON.stringify(signal));

  return json(signal);
}
