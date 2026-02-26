// Classified Ads — KV-backed with x402 payment
// GET  /api/classifieds — list active classifieds
// POST /api/classifieds — submit a classified (x402 protected, 5000 sats sBTC)

import {
  CORS, json, err, options, methodNotAllowed,
  TREASURY_STX_ADDRESS, SBTC_CONTRACT_MAINNET, X402_RELAY_URL,
  CLASSIFIED_PRICE_SATS, CLASSIFIED_DURATION_DAYS, CLASSIFIED_CATEGORIES,
  sanitizeString, checkIPRateLimit,
} from './_shared.js';

const MAX_INDEX_SIZE = 500;

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method === 'GET') return handleGet(context);
  if (context.request.method === 'POST') return handlePost(context);
  return methodNotAllowed();
}

// ── GET /api/classifieds ──

async function handleGet(context) {
  const kv = context.env.SIGNAL_KV;
  const url = new URL(context.request.url);
  const category = url.searchParams.get('category');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);

  const index = (await kv.get('classifieds:index', 'json')) || [];
  const now = Date.now();
  const classifieds = [];

  for (const id of index) {
    if (classifieds.length >= limit) break;
    const ad = await kv.get(`classified:${id}`, 'json');
    if (!ad) continue;
    // Filter expired
    if (new Date(ad.expiresAt).getTime() < now) continue;
    // Filter category
    if (category && ad.category !== category) continue;
    classifieds.push(ad);
  }

  // Count total active (for stats)
  let activeCount = 0;
  for (const id of index) {
    const ad = await kv.get(`classified:${id}`, 'json');
    if (ad && new Date(ad.expiresAt).getTime() >= now) activeCount++;
  }

  return json({ classifieds, total: index.length, activeCount }, { cache: 15 });
}

// ── POST /api/classifieds ──

async function handlePost(context) {
  const kv = context.env.SIGNAL_KV;

  // IP rate limit: 10/hour
  const rlErr = await checkIPRateLimit(kv, context.request, {
    key: 'classifieds', maxRequests: 10, windowSeconds: 3600,
  });
  if (rlErr) return rlErr;

  const paymentSig = context.request.headers.get('payment-signature');

  // Parse body
  let body;
  try {
    body = await context.request.json();
  } catch {
    return err('Invalid JSON body');
  }

  const { title, body: adBody, category, contact, paymentTxid } = body;

  // Validate fields
  if (!title || !adBody || !category) {
    return err('Missing required fields: title, body, category');
  }
  if (title.length > 100) return err('Title too long (max 100 chars)');
  if (adBody.length > 500) return err('Body too long (max 500 chars)');
  if (contact && contact.length > 200) return err('Contact too long (max 200 chars)');
  if (!CLASSIFIED_CATEGORIES.includes(category)) {
    return err(`Invalid category. Must be one of: ${CLASSIFIED_CATEGORIES.join(', ')}`);
  }

  // ── No payment → return 402 ──
  if (!paymentSig && !paymentTxid) {
    return return402();
  }

  // ── x402 payment-signature flow ──
  if (paymentSig) {
    return await handleX402Payment(kv, paymentSig, { title, adBody, category, contact });
  }

  // ── Fallback: paymentTxid in body ──
  if (paymentTxid) {
    return await handleTxidFallback(kv, paymentTxid, { title, adBody, category, contact });
  }

  return err('Payment required', 402);
}

// ── 402 Payment Required response ──

function return402() {
  const requirements = {
    x402Version: 2,
    accepts: [{
      scheme: 'exact',
      network: 'stacks:mainnet',
      amount: String(CLASSIFIED_PRICE_SATS),
      asset: SBTC_CONTRACT_MAINNET,
      payTo: TREASURY_STX_ADDRESS,
      description: `Classified ad listing — ${CLASSIFIED_DURATION_DAYS} days`,
    }],
  };

  const encoded = btoa(JSON.stringify(requirements));

  return new Response(JSON.stringify({
    error: 'Payment Required',
    message: `Place a classified ad for ${CLASSIFIED_PRICE_SATS} sats sBTC (${CLASSIFIED_DURATION_DAYS}-day listing)`,
    payTo: TREASURY_STX_ADDRESS,
    amount: CLASSIFIED_PRICE_SATS,
    asset: SBTC_CONTRACT_MAINNET,
    x402: requirements,
  }), {
    status: 402,
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'payment-required': encoded,
    },
  });
}

// ── Settle via x402 relay ──

async function handleX402Payment(kv, paymentSig, fields) {
  // Decode payment-signature (base64 JSON)
  let paymentData;
  try {
    paymentData = JSON.parse(atob(paymentSig));
  } catch {
    return err('Invalid payment-signature header (expected base64 JSON)');
  }

  // Settle with x402 relay
  let settleResult;
  try {
    const settleRes = await fetch(`${X402_RELAY_URL}/api/v1/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentSignature: paymentSig,
        paymentRequirements: {
          scheme: 'exact',
          network: 'stacks:mainnet',
          amount: String(CLASSIFIED_PRICE_SATS),
          asset: SBTC_CONTRACT_MAINNET,
          payTo: TREASURY_STX_ADDRESS,
        },
      }),
    });
    settleResult = await settleRes.json();

    if (!settleRes.ok || !settleResult.success) {
      return err(
        settleResult.error || 'Payment settlement failed',
        402,
        'Ensure you paid the correct amount to the treasury address'
      );
    }
  } catch (e) {
    return err('Settlement relay error', 502);
  }

  // Extract payer info from settlement
  const payerStxAddress = settleResult.payer || paymentData.payer || paymentData.from || '';
  const payerBtcAddress = paymentData.btcAddress || '';
  const txid = settleResult.txid || paymentData.txid || '';

  // Rate limit: max 3 active per address
  const placedBy = payerBtcAddress || payerStxAddress;
  if (placedBy) {
    const rateLimitErr = await checkRateLimit(kv, placedBy);
    if (rateLimitErr) return rateLimitErr;
  }

  // Store classified
  const classified = await storeClassified(kv, {
    ...fields,
    placedBy,
    payerStxAddress,
    paidAmount: CLASSIFIED_PRICE_SATS,
    paymentTxid: txid,
  });

  // Payment response header
  const paymentResponse = btoa(JSON.stringify({
    success: true,
    txid,
    classifiedId: classified.id,
  }));

  return new Response(JSON.stringify({ ok: true, classified }), {
    status: 201,
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'payment-response': paymentResponse,
    },
  });
}

// ── Fallback: verify txid on-chain ──

async function handleTxidFallback(kv, txid, fields) {
  // Verify the tx on Stacks API
  let tx;
  try {
    const res = await fetch(`https://api.mainnet.hiro.so/extended/v1/tx/${txid}`);
    if (!res.ok) return err('Could not verify transaction on-chain', 400);
    tx = await res.json();
  } catch (e) {
    return err('Failed to verify transaction', 502);
  }

  // Check tx is a token transfer to treasury
  if (tx.tx_status !== 'success') {
    return err('Transaction has not succeeded yet. Wait for confirmation and retry.', 400);
  }

  // Look for sBTC transfer event to treasury
  const events = tx.events || [];
  const sbtcTransfer = events.find(e =>
    e.event_type === 'fungible_token_transfer' &&
    e.asset && e.asset.asset_id === SBTC_CONTRACT_MAINNET + '::sbtc' &&
    e.asset.recipient === TREASURY_STX_ADDRESS &&
    parseInt(e.asset.amount, 10) >= CLASSIFIED_PRICE_SATS
  );

  if (!sbtcTransfer) {
    return err(
      `Transaction does not contain a valid sBTC transfer of ${CLASSIFIED_PRICE_SATS}+ sats to ${TREASURY_STX_ADDRESS}`,
      400
    );
  }

  // Check txid not already used
  const existingIndex = (await kv.get('classifieds:index', 'json')) || [];
  for (const id of existingIndex) {
    const existing = await kv.get(`classified:${id}`, 'json');
    if (existing && existing.paymentTxid === txid) {
      return err('This transaction has already been used for a classified', 409);
    }
  }

  const payerStxAddress = tx.sender_address || '';
  const placedBy = payerStxAddress;

  // Rate limit
  if (placedBy) {
    const rateLimitErr = await checkRateLimit(kv, placedBy);
    if (rateLimitErr) return rateLimitErr;
  }

  const classified = await storeClassified(kv, {
    ...fields,
    placedBy,
    payerStxAddress,
    paidAmount: CLASSIFIED_PRICE_SATS,
    paymentTxid: txid,
  });

  return json({ ok: true, classified }, { status: 201 });
}

// ── Helpers ──

async function checkRateLimit(kv, address) {
  const agentAds = (await kv.get(`classifieds:agent:${address}`, 'json')) || [];
  const now = Date.now();
  let activeCount = 0;

  for (const id of agentAds) {
    const ad = await kv.get(`classified:${id}`, 'json');
    if (ad && new Date(ad.expiresAt).getTime() >= now) activeCount++;
  }

  if (activeCount >= 3) {
    return err('Rate limit: max 3 active classifieds per address', 429);
  }
  return null;
}

async function storeClassified(kv, data) {
  const now = new Date();
  const expires = new Date(now);
  expires.setDate(expires.getDate() + CLASSIFIED_DURATION_DAYS);

  const id = `c_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const classified = {
    id,
    title: sanitizeString(data.title, 100),
    body: sanitizeString(data.adBody, 500),
    category: data.category,
    contact: data.contact ? sanitizeString(data.contact, 200) : null,
    placedBy: data.placedBy,
    payerStxAddress: data.payerStxAddress,
    paidAmount: data.paidAmount,
    paymentTxid: data.paymentTxid,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    active: true,
  };

  // Store classified object
  await kv.put(`classified:${id}`, JSON.stringify(classified));

  // Prepend to global index
  const index = (await kv.get('classifieds:index', 'json')) || [];
  index.unshift(id);
  if (index.length > MAX_INDEX_SIZE) index.length = MAX_INDEX_SIZE;
  await kv.put('classifieds:index', JSON.stringify(index));

  // Prepend to agent index
  if (data.placedBy) {
    const agentAds = (await kv.get(`classifieds:agent:${data.placedBy}`, 'json')) || [];
    agentAds.unshift(id);
    if (agentAds.length > 50) agentAds.length = 50;
    await kv.put(`classifieds:agent:${data.placedBy}`, JSON.stringify(agentAds));
  }

  return classified;
}
