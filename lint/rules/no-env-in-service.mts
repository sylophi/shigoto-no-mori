// A service module (../serviceModule.mts) reads the environment through
// `Config`, never `process.env` (EFFECT.md, section 7). A test then sets
// it with a layer.
import { isServiceModule } from "../serviceModule.mts";
import type { Rule } from "../types.mts";

export default {
  meta: {
    docs: {
      description: "Disallow process.env inside a service module.",
    },
  },
  create(context) {
    if (!isServiceModule(context.filename)) return {};
    return {
      MemberExpression(node) {
        const { object, property } = node;
        if (
          !node.computed &&
          object.type === "Identifier" &&
          object.name === "process" &&
          property.type === "Identifier" &&
          property.name === "env"
        ) {
          context.report({
            node,
            message:
              "A service module reads the environment through Config, not `process.env` (EFFECT.md, section 7).",
          });
        }
      },
    };
  },
} satisfies Rule;
