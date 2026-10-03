// An oxlint plugin with the repo's own rules.
//
// no-double-cast: no `x as unknown as T`. A double cast through unknown
// turns any value into any type with no check, and the bare `any` it
// stands in for is banned already (no-explicit-any).
//
// disable-needs-reason: every `oxlint-disable` comment ends in
// `-- <reason>`, so each cast, assertion or other exception the code
// keeps is one someone chose, with the reason next to it.
//
// no-native-tooltip: no `title` attribute on a DOM element and no SVG
// `<title>`. The browser's tooltip ignores the theme, waits its own
// delay, and can't be styled. The app's is SimpleTooltip
// (ui/tooltip.tsx). A component's own `title` prop (a dialog's heading) is its
// business: the rule sees elements whose name is lowercase (`<span>`)
// or dotted (`<Combobox.Trigger>`, a library's primitive passing props
// to the DOM). The shared wrappers that pass props through (Button,
// IconButton, Chip) leave `title` out of their prop types instead.

// The slice of oxlint's plugin api these rules use. oxlint publishes
// its own types, but lint/ has no node_modules to resolve them from.
type AstNode = { type: string };

type AsExpression = AstNode & {
  type: "TSAsExpression";
  expression: AstNode;
  typeAnnotation: AstNode;
};

type JsxName =
  | { type: "JSXIdentifier"; name: string }
  | { type: "JSXNamespacedName" }
  | { type: "JSXMemberExpression" };

type JsxOpeningElement = AstNode & {
  type: "JSXOpeningElement";
  name: JsxName;
  attributes: (
    | (AstNode & { type: "JSXAttribute"; name: JsxName })
    | (AstNode & { type: "JSXSpreadAttribute" })
  )[];
};

type Position = { line: number; column: number };

type Context = {
  sourceCode: { text: string };
  report(
    diagnostic:
      | { node: AstNode; message: string }
      | { loc: { start: Position; end: Position }; message: string },
  ): void;
};

type Plugin = {
  meta: { name: string };
  rules: Record<
    string,
    {
      meta: { docs: { description: string } };
      create(context: Context): {
        Program?: () => void;
        TSAsExpression?: (node: AsExpression) => void;
        JSXOpeningElement?: (node: JsxOpeningElement) => void;
      };
    }
  >;
};

function isAsExpression(node: AstNode): node is AsExpression {
  return node.type === "TSAsExpression";
}

// Whether `title` on this element reaches the DOM: a lowercase tag,
// or a library primitive reached through a namespace.
function isDomElement(name: JsxName): boolean {
  if (name.type === "JSXIdentifier") return /^[a-z]/.test(name.name);
  return name.type === "JSXMemberExpression";
}

// A disable comment, and everything after the directive on its line.
const DISABLE = /\/[/*]\s*oxlint-disable(?:-next-line|-line)?\b([^\n]*)/g;

function positionAt(text: string, index: number): Position {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  const column = index - (before.lastIndexOf("\n") + 1);
  return { line, column };
}

export default {
  meta: { name: "shigomori" },
  rules: {
    "no-double-cast": {
      meta: {
        docs: {
          description:
            "Disallow casting through unknown (`x as unknown as T`).",
        },
      },
      create(context) {
        return {
          TSAsExpression(node) {
            const inner = node.expression;
            if (
              isAsExpression(inner) &&
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
    },
    "no-native-tooltip": {
      meta: {
        docs: {
          description:
            "Disallow the browser's tooltip (`title` on a DOM element, SVG `<title>`).",
        },
      },
      create(context) {
        const message =
          "The browser's tooltip ignores the app's look. Wrap the element in SimpleTooltip (ui/tooltip.tsx) instead.";
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
    },
    "disable-needs-reason": {
      meta: {
        docs: {
          description:
            "Require a reason (`-- <why>`) on every oxlint-disable comment.",
        },
      },
      create(context) {
        return {
          Program() {
            const text = context.sourceCode.text;
            for (const match of text.matchAll(DISABLE)) {
              const [, tail = ""] = match;
              const rest = tail.replace(/\*\/\s*$/, "");
              if (/--\s*\S/.test(rest)) continue;
              context.report({
                loc: {
                  start: positionAt(text, match.index),
                  end: positionAt(text, match.index + match[0].length),
                },
                message:
                  "A disable comment needs a reason: `-- <why this exception is sound>`.",
              });
            }
          },
        };
      },
    },
  },
} satisfies Plugin;
