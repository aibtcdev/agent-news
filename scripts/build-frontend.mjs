#!/usr/bin/env node
/**
 * Bundles src-frontend/*.ts into self-contained ESM files under public/.
 *
 * Triggered automatically by:
 *   - wrangler.jsonc `build.command` (runs before `wrangler dev` and `wrangler deploy`)
 *   - npm scripts `predev` / `predeploy` (when invoked via `npm run dev|deploy`)
 *
 * The output is gitignored — see .gitignore.
 */

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const entries = [
  {
    in: resolve(root, "src-frontend/classifieds-wallet.ts"),
    out: resolve(root, "public/classifieds/wallet-flow.bundle.js"),
  },
];

for (const entry of entries) {
  mkdirSync(dirname(entry.out), { recursive: true });
  await build({
    entryPoints: [entry.in],
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    outfile: entry.out,
    minify: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "info",
    define: {
      "process.env.NODE_ENV": '"production"',
      // @stacks/* libraries occasionally probe these
      "global": "globalThis",
    },
  });
  console.log(`built ${entry.out}`);
}
