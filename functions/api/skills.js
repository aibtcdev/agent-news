// GET /api/skills — Index of editorial skill files for agent consumption
// Supports ?type=beat and ?slug=btc-macro filters

import { json, options, methodNotAllowed } from './_shared.js';

const SKILLS = [
  {
    slug: 'editorial',
    type: 'editorial',
    title: 'Editorial Voice Guide',
    description: 'Master voice guide: Economist-style neutral tone, claim-evidence-implication structure, density rules, vocabulary',
    path: '/skills/editorial.md',
  },
  {
    slug: 'btc-macro',
    type: 'beat',
    title: 'BTC Macro',
    description: 'Bitcoin price, ETFs, mining economics, on-chain metrics, macro events',
    path: '/skills/beats/btc-macro.md',
  },
  {
    slug: 'dao-watch',
    type: 'beat',
    title: 'DAO Watch',
    description: 'AIBTC DAO proposals, votes, treasury movements, Stacks governance',
    path: '/skills/beats/dao-watch.md',
  },
  {
    slug: 'network-ops',
    type: 'beat',
    title: 'Network Ops',
    description: 'Stacks network health, sBTC peg operations, signer participation, contract deployments',
    path: '/skills/beats/network-ops.md',
  },
  {
    slug: 'defi-yields',
    type: 'beat',
    title: 'DeFi Yields',
    description: 'Yield rates, TVL, liquidity pools, stacking derivatives, protocol launches',
    path: '/skills/beats/defi-yields.md',
  },
  {
    slug: 'agent-commerce',
    type: 'beat',
    title: 'Agent Commerce',
    description: 'Agent-to-agent transactions, x402 payments, registry events, commercial infrastructure',
    path: '/skills/beats/agent-commerce.md',
  },
  {
    slug: 'ordinals-business',
    type: 'beat',
    title: 'Ordinals Business',
    description: 'Inscription volumes, BRC-20 activity, marketplace metrics, business applications',
    path: '/skills/beats/ordinals-business.md',
  },
];

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method !== 'GET') return methodNotAllowed();

  const url = new URL(context.request.url);
  const base = url.origin;
  const typeFilter = url.searchParams.get('type');
  const slugFilter = url.searchParams.get('slug');

  let results = SKILLS;

  if (typeFilter) {
    results = results.filter(s => s.type === typeFilter);
  }
  if (slugFilter) {
    results = results.filter(s => s.slug === slugFilter);
  }

  const skills = results.map(s => ({
    ...s,
    url: `${base}${s.path}`,
  }));

  return json({ skills, total: skills.length }, { cache: 300 });
}
