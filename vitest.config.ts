import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // Run tests inside the actual Workers runtime — catches edge-only issues
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
    // Fail fast on first error during CI
    bail: 1,
  },
});
