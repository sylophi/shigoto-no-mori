import { testRule } from "../ruleTester.mts";
import rule from "./no-runtime-in-service.mts";

const service = "engine/src/Registry.ts";

testRule("no-runtime-in-service", rule, {
  valid: [
    {
      code: "export const layer = Layer.effect(Registry, make);",
      filename: service,
    },
    { code: "Effect.runPromise(program);", filename: "desktop/src/boot.ts" },
    {
      code: "Effect.runPromise(program);",
      filename: "engine/src/Registry.test.ts",
    },
    {
      code: 'import * as ManagedRuntime from "effect/ManagedRuntime";',
      filename: "host/src/runtime.ts",
    },
    { code: "options.runSyncLater();", filename: service },
  ],
  invalid: [
    {
      code: 'import * as ManagedRuntime from "effect/ManagedRuntime";',
      filename: service,
      errors: 1,
    },
    { code: "Effect.runPromise(program);", filename: service, errors: 1 },
    { code: "runtime.runPromiseExit(program);", filename: service, errors: 1 },
    {
      code: "Effect.runSync(program);",
      filename: "host/GitWatcher.mts",
      errors: 1,
    },
    { code: "Effect.runFork(program);", filename: service, errors: 1 },
  ],
});
