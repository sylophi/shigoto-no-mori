import { testRule } from "../ruleTester.mts";
import rule from "./no-env-in-service.mts";

const service = "engine/src/Registry.ts";

testRule("no-env-in-service", rule, {
  valid: [
    { code: 'const home = yield* Config.string("HOME");', filename: service },
    { code: "process.env.HOME;", filename: "host/src/boot.ts" },
    { code: "options.env.HOME;", filename: service },
  ],
  invalid: [
    { code: "process.env.HOME;", filename: service, errors: 1 },
    { code: "const env = { ...process.env };", filename: service, errors: 1 },
  ],
});
