// A service module (../serviceModule.mts) reads the environment through
// `Config` and the time through `Clock`, never `process.env` or
// `Date.now()` (EFFECT.md, section 7). A test then sets either with a
// layer, and `TestClock` moves the time.
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
