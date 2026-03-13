/**
 * Skills route — list editorial skill definitions, with beat skills loaded
 * dynamically from the Durable Object so newly-claimed beats appear immediately
 * without a Worker redeploy.
 *
 * The editorial skill is static (it will never be stored in the DB).
 * Beat skills are built at request time from the beats table.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { listBeats } from "../lib/do-client";

export interface Skill {
  slug: string;
  type: "editorial" | "beat";
  title: string;
  description: string;
  path: string;
}

/** Static skills that are not beat-specific */
const STATIC_SKILLS: Skill[] = [
  {
    slug: "editorial",
    type: "editorial",
    title: "Editorial Voice Guide",
    description:
      "Master voice guide: Economist-style neutral tone, claim-evidence-implication structure, density rules, vocabulary",
    path: "/skills/editorial.md",
  },
];

const skillsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/skills — list skill files with optional ?type and ?slug filters
skillsRouter.get("/api/skills", async (c) => {
  const base = new URL(c.req.url).origin;
  const typeFilter = c.req.query("type");
  const slugFilter = c.req.query("slug");

  // Build beat skills dynamically from the beats table
  let beatSkills: Skill[] = [];
  try {
    const beats = await listBeats(c.env);
    beatSkills = beats.map((b) => ({
      slug: b.slug,
      type: "beat" as const,
      title: b.name,
      description: b.description ?? b.name,
      path: `/skills/beats/${b.slug}.md`,
    }));
  } catch (err) {
    console.error("[skills] failed to load beats from DO, using empty list", err);
  }

  let results: Skill[] = [...STATIC_SKILLS, ...beatSkills];

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
