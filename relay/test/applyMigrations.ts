// Vitest setup: bring the isolated test D1 to the current schema
// before any test runs.
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
