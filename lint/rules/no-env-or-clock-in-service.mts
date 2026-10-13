// A service module (../serviceModule.mts) reads the environment through
// `Config` and the time through `Clock`, never `process.env`,
// `Date.now()` or `new Date()` (EFFECT.md, section 7). A test then sets
// either with a layer, and `TestClock` moves the time.
import { isServiceModule } from "../serviceModule.mts";
import type { Rule } from "../types.mts";

export default {
  meta: {
    docs: {
      description:
        "Disallow process.env and Date.now() inside a service module.",
    },
  },
  create(context) {
    if (!isServiceModule(context.filename)) return {};
    return {
      // The current time; `new Date(at)` only formats one.
      NewExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "Date" &&
          node.arguments.length === 0
        ) {
          context.report({
            node,
            message:
              "A service module reads the time through Clock, not `new Date()` (EFFECT.md, section 7).",
          });
        }
      },
      MemberExpression(node) {
        const { object, property } = node;
        if (
          !node.computed &&
          object.type === "Identifier" &&
          property.type === "Identifier" &&
          ((object.name === "process" && property.name === "env") ||
            (object.name === "Date" && property.name === "now"))
        ) {
          context.report({
            node,
            message: `A service module reads ${object.name === "process" ? "the environment through Config" : "the time through Clock"}, not \`${object.name}.${property.name}\` (EFFECT.md, section 7).`,
          });
        }
      },
    };
  },
} satisfies Rule;
