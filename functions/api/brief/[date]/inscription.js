// GET /api/brief/:date/inscription — Check inscription status for a brief

import { json, err, options, methodNotAllowed } from '../../_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method !== 'GET') return methodNotAllowed();

  const kv = context.env.SIGNAL_KV;
  const date = context.params.date;

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return err('Invalid date format', 400, 'Use YYYY-MM-DD');
  }

  const brief = await kv.get(`brief:${date}`, 'json');
  if (!brief) {
    return err(`No brief found for ${date}`, 404);
  }

  if (!brief.inscription) {
    return json({ date, inscribed: false }, { cache: 300 });
  }

  return json({
    date,
    inscribed: true,
    inscriptionId: brief.inscription.inscriptionId,
    ordinalLink: `https://ordinals.com/inscription/${brief.inscription.inscriptionId}`,
    inscribedBy: brief.inscription.inscribedBy,
    inscribedAt: brief.inscription.inscribedAt,
  }, { cache: 300 });
}
