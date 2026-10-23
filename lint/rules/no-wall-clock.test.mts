import { testRule } from "../ruleTester.mts";
import rule from "./no-wall-clock.mts";

const service = "ui/src/Registry.ts";
const helper = "/repo/app/shared/hub/link.ts";

testRule("no-wall-clock", rule, {
  valid: [
    { code: "const now = yield* Clock.currentTimeMillis;", filename: service },
    { code: "const at = clock.currentTimeMillisUnsafe();", filename: service },
    { code: "new Date(at).toISOString();", filename: helper },
    { code: "Date.now();", filename: "/repo/app/renderer/lib/time.ts" },
    {
      code: "Date.now();",
      filename: "/repo/packages/engine/src/Registry.test.ts",
    },
    { code: "Date.now();", filename: "/repo/packages/engine/test/sandbox.ts" },
    { code: "Date.now();", filename: "/repo/app/lab/reliability/run.mts" },
    { code: "Date.now();", filename: "/repo/packages/cli/test/cli.test.ts" },
  ],
  invalid: [
    { code: "const at = Date.now();", filename: service, errors: 1 },
    { code: "const now = Date.now;", filename: service, errors: 1 },
    { code: "new Date().toISOString();", filename: service, errors: 1 },
    { code: "Date.now() - started;", filename: helper, errors: 1 },
    {
      code: "Date.now();",
      filename: "/repo/app/main/hostProcess.ts",
      errors: 1,
    },
    {
      code: "Date.now();",
      filename: "/repo/app/host/mirror/oneShot.ts",
      errors: 1,
    },
    {
      code: "Date.now();",
      filename: "/repo/packages/engine/src/worktrees/moving.ts",
      errors: 1,
    },
    {
      code: "Date.now();",
      filename: "/repo/packages/contracts/src/sharedSettings.ts",
      errors: 1,
    },
    {
      code: "Date.now();",
      filename: "/repo/packages/cli/src/commands/nuke.ts",
      errors: 1,
    },
  ],
});
