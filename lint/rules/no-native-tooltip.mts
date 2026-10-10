// No `title` attribute on a DOM element and no SVG `<title>`. The
// browser's tooltip ignores the theme, waits its own delay, and can't be
// styled. The app's is SimpleTooltip (primitives/tooltip.tsx). A component's own
// `title` prop (a dialog's heading) is its business: the rule sees
// elements whose name is lowercase (`<span>`) or dotted
// (`<Combobox.Trigger>`, a library's primitive passing props to the
// DOM). The shared wrappers that pass props through (Button, IconButton,
// Chip) leave `title` out of their prop types instead.
import type { Node, Rule } from "../types.mts";

type JsxName = Node<"JSXOpeningElement">["name"];

// Whether `title` on this element reaches the DOM: a lowercase tag, or
// a library primitive reached through a namespace.
function isDomElement(name: JsxName): boolean {
  if (name.type === "JSXIdentifier") return /^[a-z]/.test(name.name);
  return name.type === "JSXMemberExpression";
}

const message =
  "The browser's tooltip ignores the app's look. Wrap the element in SimpleTooltip (primitives/tooltip.tsx) instead.";

export default {
  meta: {
    docs: {
      description:
        "Disallow the browser's tooltip (`title` on a DOM element, SVG `<title>`).",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        const { name } = node;
        if (name.type === "JSXIdentifier" && name.name === "title") {
          context.report({ node, message });
          return;
        }
        if (!isDomElement(name)) return;
        for (const attribute of node.attributes) {
          if (
            attribute.type === "JSXAttribute" &&
            attribute.name.type === "JSXIdentifier" &&
            attribute.name.name === "title"
          ) {
            context.report({ node: attribute, message });
          }
        }
      },
    };
  },
} satisfies Rule;
