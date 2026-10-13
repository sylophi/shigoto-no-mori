import { testRule } from "../ruleTester.mts";
import rule from "./no-env-or-clock-in-service.mts";

const service = "engine/src/Registry.ts";

testRule("no-env-or-clock-in-service", rule, {
  valid: [
    { code: "const now = yield* Clock.currentTimeMillis;", filename: service },
    { code: 'const home = yield* Config.string("HOME");', filename: service },
    { code: "const at = clock.currentTimeMillisUnsafe();", filename: service },
    { code: "process.env.HOME;", filename: "host/src/boot.ts" },
    { code: "Date.now();", filename: "engine/src/Registry.test.ts" },
    { code: "options.env.HOME;", filename: service },
    { code: "new Date(at).toISOString();", filename: service },
  ],
  invalid: [
    { code: "process.env.HOME;", filename: service, errors: 1 },
    { code: "const env = { ...process.env };", filename: service, errors: 1 },
    { code: "const at = Date.now();", filename: service, errors: 1 },
    { code: "const now = Date.now;", filename: service, errors: 1 },
    { code: "new Date().toISOString();", filename: service, errors: 1 },
    {
      code: "Date.now() - started;",
      filename: "host/GitWatcher.mts",
      errors: 1,
    },
  ],
});
