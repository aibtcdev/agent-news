// GET /api/classifieds/:id — single classified by ID

import { CORS, json, err, options } from '../_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method !== 'GET') return err('Method not allowed', 405);

  const kv = context.env.SIGNAL_KV;
  const id = context.params.id;

  const classified = await kv.get(`classified:${id}`, 'json');
  if (!classified) {
    return err('Classified not found', 404);
  }

  return json(classified, { cache: 30 });
}
