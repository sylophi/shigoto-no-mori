import { testRule } from "../ruleTester.mts";
import rule from "./effect-namespace-imports.mts";

testRule("effect-namespace-imports", rule, {
  valid: [
    { code: 'import * as Effect from "effect/Effect";', filename: "a.ts" },
    { code: 'import type { Scope } from "effect/Scope";', filename: "a.ts" },
    { code: 'import { type Scope } from "effect/Scope";', filename: "a.ts" },
    { code: 'import { describe } from "vitest";', filename: "a.ts" },
    { code: 'import * as X from "effects/Effect";', filename: "a.ts" },
  ],
  invalid: [
    { code: 'import { Effect } from "effect";', filename: "a.ts", errors: 1 },
    { code: 'import * as E from "effect";', filename: "a.ts", errors: 1 },
    {
      code: 'import type { Effect } from "effect";',
      filename: "a.ts",
      errors: 1,
    },
    {
      code: 'import { gen } from "effect/Effect";',
      filename: "a.ts",
      errors: [{ message: /import \* as Effect from "effect\/Effect"/ }],
    },
    {
      code: 'import Effect from "effect/Effect";',
      filename: "a.ts",
      errors: 1,
    },
  ],
});
