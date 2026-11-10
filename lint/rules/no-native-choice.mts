// No `<input type="checkbox">` or `<input type="radio">`. The browser
// draws those its own way in every theme, and doubutsu's fills never
// reach them. A tick box is Checkbox, an on/off is Switch, and one of a
// few is an OptionCard or a SegmentedControl (primitives/).
import type { Rule } from "../types.mts";

const message =
  "The browser's own checkbox and radio ignore the app's look. Use Checkbox, Switch, OptionCard or SegmentedControl (primitives/) instead.";

export default {
  meta: {
    docs: {
      description: "Disallow the browser's own checkbox and radio inputs.",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        const { name } = node;
        if (name.type !== "JSXIdentifier" || name.name !== "input") return;
        for (const attribute of node.attributes) {
          if (
            attribute.type !== "JSXAttribute" ||
            attribute.name.type !== "JSXIdentifier" ||
            attribute.name.name !== "type"
          ) {
            continue;
          }
          // `type="radio"`, or the same in braces.
          const value =
            attribute.value?.type === "JSXExpressionContainer"
              ? attribute.value.expression
              : attribute.value;
          if (
            value?.type === "Literal" &&
            (value.value === "checkbox" || value.value === "radio")
          ) {
            context.report({ node: attribute, message });
          }
        }
      },
    };
  },
} satisfies Rule;
