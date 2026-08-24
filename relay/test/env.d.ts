// Types the `env` the test harness hands out (cloudflare:test types it
// as the global Cloudflare.Env): the real bindings from wrangler.jsonc
// plus the migrations injected by vitest.config.ts.
import type { D1Migration } from "cloudflare:test";
import type { Env as RelayEnv } from "../src/env.ts";

declare global {
  namespace Cloudflare {
    interface Env extends RelayEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
