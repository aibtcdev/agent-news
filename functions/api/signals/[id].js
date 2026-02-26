// Get a single signal by ID
// GET /api/signals/:id

import { json, err, options, methodNotAllowed } from '../_shared.js';

export async function onRequestGet(context) {
  const kv = context.env.SIGNAL_KV;
  const id = context.params.id;

  const signal = await kv.get(`signal:${id}`, 'json');
  if (!signal) {
    return err('Signal not found', 404);
  }

  return json(signal, { cache: 60 });
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method === 'GET') return onRequestGet(context);
  return methodNotAllowed();
}
