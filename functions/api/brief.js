// GET /api/brief — Read the latest compiled intelligence brief
// When BRIEFS_FREE is true, returns full brief without payment.
// When false, gated behind x402 (1000 sats sBTC).

import {
  CORS, json, err, options, methodNotAllowed,
  TREASURY_STX_ADDRESS, SBTC_CONTRACT_MAINNET, X402_RELAY_URL,
  BRIEF_PRICE_SATS, CORRESPONDENT_SHARE,
} from './_shared.js';

// ── Free-brief toggle (set false to re-enable x402 paywall) ──
const BRIEFS_FREE = true;

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method !== 'GET') return methodNotAllowed();

  const kv = context.env.SIGNAL_KV;
  const url = new URL(context.request.url);
  const format = url.searchParams.get('format') || 'json';

  // Try today's brief first, then find the most recent
  const today = new Date().toISOString().slice(0, 10);
  const briefIndex = (await kv.get('briefs:index', 'json')) || [];

  let briefDate = null;
  if (briefIndex.includes(today)) {
    briefDate = today;
  } else if (briefIndex.length > 0) {
    briefDate = briefIndex[0]; // Most recent
  }

  if (!briefDate) {
    return err(
      'No briefs compiled yet',
      404,
      'POST /api/brief/compile to compile the first brief'
    );
  }

  const brief = await kv.get(`brief:${briefDate}`, 'json');
  if (!brief) {
    return err('Brief data missing', 500);
  }

  // ── Free-brief bypass ──
  if (BRIEFS_FREE) {
    if (format === 'text') {
      return new Response(brief.text, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
    return new Response(JSON.stringify({
      date: briefDate,
      compiledAt: brief.compiledAt,
      latest: briefDate === today,
      archive: briefIndex,
      inscription: brief.inscription || null,
      ...brief.json,
      text: brief.text,
    }), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // ── x402 gate (active when BRIEFS_FREE = false) ──
  const paymentSig = context.request.headers.get('payment-signature');

  if (!paymentSig) {
    // Return preview — summary stats, archive, beat names, but NO section content
    return returnPreview(brief, briefDate, today, briefIndex);
  }

  // ── Settle payment via x402 relay ──
  let paymentData;
  try {
    paymentData = JSON.parse(atob(paymentSig));
  } catch {
    return err('Invalid payment-signature header (expected base64 JSON)');
  }

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
          amount: String(BRIEF_PRICE_SATS),
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

  const txid = settleResult.txid || paymentData.txid || '';
  const payerAddress = settleResult.payer || paymentData.payer || paymentData.from || '';

  // ── Credit correspondent earnings (70/30 split) ──
  await creditCorrespondentEarnings(kv, brief, briefDate, txid);

  // ── Record payment ──
  const payments = (await kv.get(`brief-payments:${briefDate}`, 'json')) || [];
  payments.push({
    txid,
    payer: payerAddress,
    amount: BRIEF_PRICE_SATS,
    paidAt: new Date().toISOString(),
  });
  await kv.put(`brief-payments:${briefDate}`, JSON.stringify(payments));

  // ── Return full brief ──
  if (format === 'text') {
    return new Response(brief.text, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  const paymentResponse = btoa(JSON.stringify({
    success: true,
    txid,
    date: briefDate,
  }));

  return new Response(JSON.stringify({
    date: briefDate,
    compiledAt: brief.compiledAt,
    latest: briefDate === today,
    archive: briefIndex,
    inscription: brief.inscription || null,
    ...brief.json,
    text: brief.text,
  }), {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'payment-response': paymentResponse,
    },
  });
}

// ── Preview response (402) ──

function returnPreview(brief, briefDate, today, briefIndex) {
  const report = brief.json || {};
  const beatNames = (report.sections || []).map(s => s.beat);
  const uniqueBeats = [...new Set(beatNames)];

  const preview = {
    preview: true,
    date: briefDate,
    compiledAt: brief.compiledAt,
    latest: briefDate === today,
    archive: briefIndex,
    inscription: brief.inscription || null,
    summary: report.summary || null,
    beats: uniqueBeats,
    price: {
      amount: BRIEF_PRICE_SATS,
      asset: 'sBTC (sats)',
      protocol: 'x402',
    },
  };

  const requirements = {
    x402Version: 2,
    accepts: [{
      scheme: 'exact',
      network: 'stacks:mainnet',
      amount: String(BRIEF_PRICE_SATS),
      asset: SBTC_CONTRACT_MAINNET,
      payTo: TREASURY_STX_ADDRESS,
      description: `Daily intelligence brief — ${briefDate}`,
    }],
  };

  const encoded = btoa(JSON.stringify(requirements));

  return new Response(JSON.stringify(preview), {
    status: 402,
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'payment-required': encoded,
    },
  });
}

// ── Revenue split: 70% to correspondents, 30% stays in treasury ──

async function creditCorrespondentEarnings(kv, brief, briefDate, txid) {
  const report = brief.json || {};
  const sections = report.sections || [];
  if (sections.length === 0) return;

  // Find unique correspondents
  const correspondentAddresses = [...new Set(sections.map(s => s.correspondent))];
  if (correspondentAddresses.length === 0) return;

  const totalCorrespondentSats = Math.floor(BRIEF_PRICE_SATS * CORRESPONDENT_SHARE);
  const perCorrespondent = Math.floor(totalCorrespondentSats / correspondentAddresses.length);

  if (perCorrespondent === 0) return;

  // Credit each correspondent
  await Promise.all(correspondentAddresses.map(async (addr) => {
    const earningsKey = `earnings:${addr}`;
    const earnings = (await kv.get(earningsKey, 'json')) || { total: 0, payments: [] };

    earnings.total += perCorrespondent;
    earnings.payments.unshift({
      date: briefDate,
      amount: perCorrespondent,
      txid,
    });
    // Keep last 100 payment records
    if (earnings.payments.length > 100) earnings.payments.length = 100;

    await kv.put(earningsKey, JSON.stringify(earnings));
  }));
}
