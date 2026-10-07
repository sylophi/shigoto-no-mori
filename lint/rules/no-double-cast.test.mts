import { testRule } from "../ruleTester.mts";
import rule from "./no-double-cast.mts";

testRule("no-double-cast", rule, {
  valid: [
    { code: "const a = b as string;", filename: "a.ts" },
    { code: "const a = b as unknown;", filename: "a.ts" },
    { code: "const a = (b as string) as never;", filename: "a.ts" },
  ],
  invalid: [
    { code: "const a = b as unknown as string;", filename: "a.ts", errors: 1 },
    {
      code: "f((b as unknown) as Map<string, number>);",
      filename: "a.ts",
      errors: 1,
    },
  ],
});
