import { testRule } from "../ruleTester.mts";
import rule from "./no-native-tooltip.mts";

testRule("no-native-tooltip", rule, {
  valid: [
    { code: "<Dialog title='Rename' />;", filename: "a.tsx" },
    { code: "<span aria-label='Pinned' />;", filename: "a.tsx" },
    { code: "<span {...props} />;", filename: "a.tsx" },
  ],
  invalid: [
    { code: "<span title='Pinned' />;", filename: "a.tsx", errors: 1 },
    {
      code: "<Combobox.Trigger title='Pick' />;",
      filename: "a.tsx",
      errors: 1,
    },
    {
      code: "<svg><title>Logo</title></svg>;",
      filename: "a.tsx",
      errors: 1,
    },
  ],
});
