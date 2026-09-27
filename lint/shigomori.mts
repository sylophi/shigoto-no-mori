// An oxlint plugin with the repo's own rules.
//
// no-double-cast: no `x as unknown as T`. A double cast through unknown
// turns any value into any type with no check, and the bare `any` it
// stands in for is banned already (no-explicit-any).
//
// disable-needs-reason: every `oxlint-disable` comment ends in
// `-- <reason>`, so each cast, assertion or other exception the code
// keeps is one someone chose, with the reason next to it.

// The slice of oxlint's plugin api these rules use. oxlint publishes
// its own types, but lint/ has no node_modules to resolve them from.
type AstNode = { type: string };

type AsExpression = AstNode & {
  type: "TSAsExpression";
  expression: AstNode;
  typeAnnotation: AstNode;
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
      };
    }
  >;
};

function isAsExpression(node: AstNode): node is AsExpression {
  return node.type === "TSAsExpression";
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
