import { testRule } from "../ruleTester.mts";
import rule from "./disable-needs-reason.mts";

testRule("disable-needs-reason", rule, {
  valid: [
    "// oxlint-disable-next-line no-await-in-loop -- one probe at a time\nx;",
    "/* oxlint-disable no-console -- a CLI prints */\nx;",
    "// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the id\nx;",
    { code: "// @ts-expect-error the old shape\nx;", filename: "a.ts" },
    { code: "// @ts-ignore: a stand-in\nx;", filename: "a.ts" },
    "// a comment that mentions oxlint-disable in passing\nx;",
    "const s = '// oxlint-disable-next-line no-console';",
    "// oxlint-enable no-console\nx;",
  ],
  invalid: [
    { code: "// oxlint-disable-next-line no-console\nx;", errors: 1 },
    { code: "// oxlint-disable-line no-console --\nx;", errors: 1 },
    { code: "/* oxlint-disable no-console */\nx;", errors: 1 },
    { code: "// eslint-disable-next-line no-console\nx;", errors: 1 },
    { code: "// @ts-expect-error\nx;", filename: "a.ts", errors: 1 },
    { code: "// @ts-ignore --\nx;", filename: "a.ts", errors: 1 },
    { code: "// @ts-nocheck\nx;", filename: "a.ts", errors: 1 },
  ],
});
