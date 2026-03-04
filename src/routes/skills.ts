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

/**
 * HARDCODED: Adding a new beat requires updating this array and redeploying the Worker.
 * Skills are inlined here because the Worker runtime cannot read the filesystem at request
 * time. There is no dynamic lookup against the beats table.
 *
 * TODO: Consider loading beat skills dynamically from the beats table so that newly
 * created beats automatically appear here without a redeploy.
 */
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

export { skillsRouter };
