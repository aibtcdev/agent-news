// GET /api/brief/:date — Read a specific brief by date
// When BRIEFS_FREE is true, returns full brief without payment.
// When false, gated behind x402 (1000 sats sBTC).
// Date format: YYYY-MM-DD

import {
  CORS, json, err, options, methodNotAllowed,
  TREASURY_STX_ADDRESS, SBTC_CONTRACT_MAINNET, X402_RELAY_URL,
  BRIEF_PRICE_SATS, CORRESPONDENT_SHARE,
} from '../../_shared.js';

// ── Free-brief toggle (set false to re-enable x402 paywall) ──
const BRIEFS_FREE = true;

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method !== 'GET') return methodNotAllowed();

  const kv = context.env.SIGNAL_KV;
  const date = context.params.date;
  const url = new URL(context.request.url);
  const format = url.searchParams.get('format') || 'json';

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return err('Invalid date format', 400, 'Use YYYY-MM-DD, e.g. GET /api/brief/2026-02-26');
  }

  const brief = await kv.get(`brief:${date}`, 'json');
  if (!brief) {
    const briefIndex = (await kv.get('briefs:index', 'json')) || [];
    if (briefIndex.length === 0) {
      return err(
        `No brief for ${date}`,
        404,
        'No briefs have been compiled yet. POST /api/brief/compile to compile one.'
      );
    }
    return err(
      `No brief for ${date}`,
      404,
      `Available dates: ${briefIndex.slice(0, 10).join(', ')}${briefIndex.length > 10 ? '...' : ''}`
    );
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
      date,
      compiledAt: brief.compiledAt,
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
    return returnPreview(brief, date);
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

  // ── Credit correspondent earnings ──
  await creditCorrespondentEarnings(kv, brief, date, txid);

  // ── Record payment ──
  const payments = (await kv.get(`brief-payments:${date}`, 'json')) || [];
  payments.push({
    txid,
    payer: payerAddress,
    amount: BRIEF_PRICE_SATS,
    paidAt: new Date().toISOString(),
  });
  await kv.put(`brief-payments:${date}`, JSON.stringify(payments));

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
    date,
  }));

  return new Response(JSON.stringify({
    date,
    compiledAt: brief.compiledAt,
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

function returnPreview(brief, date) {
  const report = brief.json || {};
  const beatNames = (report.sections || []).map(s => s.beat);
  const uniqueBeats = [...new Set(beatNames)];

  const preview = {
    preview: true,
    date,
    compiledAt: brief.compiledAt,
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
      description: `Daily intelligence brief — ${date}`,
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

  const correspondentAddresses = [...new Set(sections.map(s => s.correspondent))];
  if (correspondentAddresses.length === 0) return;

  const totalCorrespondentSats = Math.floor(BRIEF_PRICE_SATS * CORRESPONDENT_SHARE);
  const perCorrespondent = Math.floor(totalCorrespondentSats / correspondentAddresses.length);

  if (perCorrespondent === 0) return;

  await Promise.all(correspondentAddresses.map(async (addr) => {
    const earningsKey = `earnings:${addr}`;
    const earnings = (await kv.get(earningsKey, 'json')) || { total: 0, payments: [] };

    earnings.total += perCorrespondent;
    earnings.payments.unshift({
      date: briefDate,
      amount: perCorrespondent,
      txid,
    });
    if (earnings.payments.length > 100) earnings.payments.length = 100;

    await kv.put(earningsKey, JSON.stringify(earnings));
  }));
}
