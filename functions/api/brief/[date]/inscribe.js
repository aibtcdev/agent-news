// POST /api/brief/:date/inscribe — Report a brief has been inscribed on Bitcoin
// Body: { btcAddress, signature, inscriptionId }

import {
  json, err, options, methodNotAllowed,
  validateBtcAddress, validateSignatureFormat, checkIPRateLimit,
} from '../../_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method !== 'POST') return methodNotAllowed();

  const kv = context.env.SIGNAL_KV;
  const date = context.params.date;

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return err('Invalid date format', 400, 'Use YYYY-MM-DD');
  }

  // IP rate limit: 5/hour
  const rlErr = await checkIPRateLimit(kv, context.request, {
    key: 'brief-inscribe', maxRequests: 5, windowSeconds: 3600,
  });
  if (rlErr) return rlErr;

  let body;
  try {
    body = await context.request.json();
  } catch {
    return err('Invalid JSON body');
  }

  const { btcAddress, signature, inscriptionId } = body;

  if (!btcAddress || !signature || !inscriptionId) {
    return err('Missing required fields: btcAddress, signature, inscriptionId');
  }

  if (!validateBtcAddress(btcAddress)) {
    return err('Invalid BTC address format (expected bech32 bc1...)');
  }

  if (!validateSignatureFormat(signature)) {
    return err('Invalid signature format (expected base64, 20-200 chars)', 401);
  }

  // Validate inscription ID format: {64-char txid}i{index} or numeric ordinal number
  const isTxidFormat = /^[a-f0-9]{64}i\d+$/.test(inscriptionId);
  const isOrdinalNumber = /^\d+$/.test(inscriptionId);
  if (!isTxidFormat && !isOrdinalNumber) {
    return err(
      'Invalid inscription ID format',
      400,
      'Expected {txid}i{index} (e.g. abc123...i0) or numeric ordinal number'
    );
  }

  // Load the brief
  const brief = await kv.get(`brief:${date}`, 'json');
  if (!brief) {
    return err(`No brief found for ${date}`, 404);
  }

  // Check if already inscribed
  if (brief.inscription) {
    return err(`Brief for ${date} is already inscribed (${brief.inscription.inscriptionId})`, 409);
  }

  // Store inscription data on the brief object
  brief.inscription = {
    inscriptionId,
    inscribedBy: btcAddress,
    inscribedAt: new Date().toISOString(),
    signature,
  };

  await kv.put(`brief:${date}`, JSON.stringify(brief));

  return json({
    ok: true,
    date,
    inscription: brief.inscription,
  }, { status: 201 });
}
