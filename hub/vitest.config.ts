// Runs the suite inside workerd via @cloudflare/vitest-pool-workers,
// so D1, Durable Objects and websockets are the real implementations
// (miniflare), no mocks. The wrangler config is the single source of
// bindings. Migrations are read here on the node side and handed to
// the worker-side setup file as a binding, the documented pattern.
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    join(import.meta.dirname, "migrations"),
  );
  return {
    plugins: [
      cloudflareTest({
        // No per-test storage isolation exists in the vitest 4 pool,
        // so tests use unique account and device ids instead, which
        // isolates them just as well. applyD1Migrations skips
        // already-applied migrations, so the setup file stays
        // idempotent however often it runs.
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/applyMigrations.ts"],
    },
  };
});
