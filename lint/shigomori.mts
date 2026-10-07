// The repo's own oxlint rules, one per file in rules/, each with its
// test beside it. README.md lists them.
import disableNeedsReason from "./rules/disable-needs-reason.mts";
import effectNamespaceImports from "./rules/effect-namespace-imports.mts";
import noDoubleCast from "./rules/no-double-cast.mts";
import noNativeTooltip from "./rules/no-native-tooltip.mts";
import noNodeBuiltinsInService from "./rules/no-node-builtins-in-service.mts";
import noRuntimeInService from "./rules/no-runtime-in-service.mts";
import type { Rule } from "./types.mts";

export default {
  meta: { name: "shigomori" },
  rules: {
    "disable-needs-reason": disableNeedsReason,
    "effect-namespace-imports": effectNamespaceImports,
    "no-double-cast": noDoubleCast,
    "no-native-tooltip": noNativeTooltip,
    "no-node-builtins-in-service": noNodeBuiltinsInService,
    "no-runtime-in-service": noRuntimeInService,
  },
} satisfies { meta: { name: string }; rules: Record<string, Rule> };
