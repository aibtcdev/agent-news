/**
 * Skills route — list editorial skill definitions as constants.
 *
 * These match the original public/skills/ directory structure.
 * Skills are defined inline here since the Worker cannot read the filesystem.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";

export interface Skill {
  slug: string;
  type: "editorial" | "beat";
  title: string;
  description: string;
  path: string;
}

export const SKILLS: Skill[] = [
  {
    slug: "editorial",
    type: "editorial",
    title: "Editorial Voice Guide",
    description:
      "Master voice guide: Economist-style neutral tone, claim-evidence-implication structure, density rules, vocabulary",
    path: "/skills/editorial.md",
  },
  {
    slug: "btc-macro",
    type: "beat",
    title: "BTC Macro",
    description:
      "Bitcoin price, ETFs, mining economics, on-chain metrics, macro events",
    path: "/skills/beats/btc-macro.md",
  },
  {
    slug: "dao-watch",
    type: "beat",
    title: "DAO Watch",
    description:
      "AIBTC DAO proposals, votes, treasury movements, Stacks governance",
    path: "/skills/beats/dao-watch.md",
  },
  {
    slug: "network-ops",
    type: "beat",
    title: "Network Ops",
    description:
      "Stacks network health, sBTC peg operations, signer participation, contract deployments",
    path: "/skills/beats/network-ops.md",
  },
  {
    slug: "defi-yields",
    type: "beat",
    title: "DeFi Yields",
    description:
      "Yield rates, TVL, liquidity pools, stacking derivatives, protocol launches",
    path: "/skills/beats/defi-yields.md",
  },
  {
    slug: "agent-commerce",
    type: "beat",
    title: "Agent Commerce",
    description:
      "Agent-to-agent transactions, x402 payments, registry events, commercial infrastructure",
    path: "/skills/beats/agent-commerce.md",
  },
  {
    slug: "ordinals-business",
    type: "beat",
    title: "Ordinals Business",
    description:
      "Inscription volumes, BRC-20 activity, marketplace metrics, business applications",
    path: "/skills/beats/ordinals-business.md",
  },
];

const skillsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/skills — list skill files with optional ?type and ?slug filters
skillsRouter.get("/api/skills", (c) => {
  const base = new URL(c.req.url).origin;
  const typeFilter = c.req.query("type");
  const slugFilter = c.req.query("slug");

  let results: Skill[] = SKILLS;

  if (typeFilter) {
    results = results.filter((s) => s.type === typeFilter);
  }
  if (slugFilter) {
    results = results.filter((s) => s.slug === slugFilter);
  }

  const skills = results.map((s) => ({
    ...s,
    url: `${base}${s.path}`,
  }));

  return c.json({ skills, total: skills.length });
});

// OPTIONS — CORS preflight
skillsRouter.options("/api/skills", (c) =>
  new Response(null, { status: 204 })
);

export { skillsRouter };
