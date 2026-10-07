// No `x as unknown as T`. A double cast through unknown turns any value
// into any type with no check, and the bare `any` it stands in for is
// banned already (no-explicit-any).
import type { Rule } from "../types.mts";

export default {
  meta: {
    docs: {
      description: "Disallow casting through unknown (`x as unknown as T`).",
    },
  },
  create(context) {
    return {
      TSAsExpression(node) {
        const inner = node.expression;
        if (
          inner.type === "TSAsExpression" &&
          inner.typeAnnotation.type === "TSUnknownKeyword"
        ) {
          context.report({
            node,
            message:
              "A cast through unknown claims a type without a check. Narrow it instead, or opt in with `// oxlint-disable-next-line shigomori/no-double-cast -- <reason>`.",
          });
        }
      },
    };
  },
} satisfies Rule;
