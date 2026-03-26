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
      // Override ENVIRONMENT so test-only endpoints (e.g. /api/test-seed) are accessible
      miniflare: {
        serviceBindings: {
          LOGS: async () => new Response("ok"),
          // X402_RELAY is stubbed so miniflare can start without the external service.
          // Tests that exercise verifyPayment() pass their own mock via the Env argument.
          X402_RELAY: async () => new Response("ok"),
        },
        bindings: {
          ENVIRONMENT: "test",
        },
      },
    }),
  ],
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    // Scoring math tests call /api/leaderboard which resolves agent names with a 3s timeout.
    // Increase global test timeout to avoid flaky timeouts in integration tests.
    testTimeout: 15000,
  },
});
