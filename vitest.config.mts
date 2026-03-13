import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    // cloudflareTest registers the vite plugin that resolves cloudflare:test
    // and sets the pool runner to cloudflare-pool automatically
    cloudflareTest({
      // Main entrypoint — required for SELF binding and DurableObject access in tests
      main: "./src/index.ts",
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
  ],
  test: {
    include: ["src/__tests__/**/*.test.ts"],
  },
});
