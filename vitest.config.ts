import { defineConfig } from "vitest/config";
import { cloudflarePool } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  test: {
    // Run tests inside the Workers runtime using miniflare
    pool: cloudflarePool({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      // Provide a stub for LOGS (external service binding unavailable in tests)
      miniflare: {
        serviceBindings: {
          LOGS: async () => new Response("ok"),
        },
      },
    }),
    include: ["src/__tests__/**/*.test.ts"],
  },
});
