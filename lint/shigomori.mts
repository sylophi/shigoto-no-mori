// The repo's own oxlint rules, one per file in rules/. README.md lists
// them.
import disableNeedsReason from "./rules/disable-needs-reason.mts";
import effectFnServiceMethods from "./rules/effect-fn-service-methods.mts";
import effectNamespaceImports from "./rules/effect-namespace-imports.mts";
import noDoubleCast from "./rules/no-double-cast.mts";
import noEnvInService from "./rules/no-env-in-service.mts";
import noNativeTooltip from "./rules/no-native-tooltip.mts";
import noNodeBuiltinsInService from "./rules/no-node-builtins-in-service.mts";
import noProcessPlatform from "./rules/no-process-platform.mts";
import noRuntimeInService from "./rules/no-runtime-in-service.mts";
import noWallClock from "./rules/no-wall-clock.mts";
import type { Rule } from "./types.mts";

export default {
  meta: { name: "shigomori" },
  rules: {
    "disable-needs-reason": disableNeedsReason,
    "effect-fn-service-methods": effectFnServiceMethods,
    "effect-namespace-imports": effectNamespaceImports,
    "no-double-cast": noDoubleCast,
    "no-env-in-service": noEnvInService,
    "no-native-tooltip": noNativeTooltip,
    "no-node-builtins-in-service": noNodeBuiltinsInService,
    "no-process-platform": noProcessPlatform,
    "no-runtime-in-service": noRuntimeInService,
    "no-wall-clock": noWallClock,
  },
} satisfies { meta: { name: string }; rules: Record<string, Rule> };
