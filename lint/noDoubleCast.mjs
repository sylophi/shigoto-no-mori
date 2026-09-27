// An oxlint plugin with one rule: no `x as unknown as T`. A double cast
// through unknown turns any value into any type with no check, and the
// bare `any` it stands in for is banned already (no-explicit-any). The
// two the codebase keeps opt in with a disable comment that says why:
//
//   // oxlint-disable-next-line shigomori/no-double-cast -- <reason>
//
// The rule also refuses such a comment without a reason after `--`.
const RULE = "shigomori/no-double-cast";

// A disable comment naming this rule, and what follows the rule list.
const DISABLE =
  /\/[/*]\s*oxlint-disable(?:-next-line|-line)?\b[^\n]*?\bshigomori\/no-double-cast\b([^\n]*)/g;

function positionAt(text, index) {
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
              inner.type === "TSAsExpression" &&
              inner.typeAnnotation.type === "TSUnknownKeyword"
            ) {
              context.report({
                node,
                message:
                  "A cast through unknown claims a type without a check. Narrow it instead, or opt in with `// oxlint-disable-next-line " +
                  RULE +
                  " -- <reason>`.",
              });
            }
          },
          Program() {
            const text = context.sourceCode.text;
            for (const match of text.matchAll(DISABLE)) {
              const reason = match[1].replace(/\*\/\s*$/, "").trim();
              if (/^--\s*\S/.test(reason)) continue;
              const start = positionAt(text, match.index);
              const end = positionAt(text, match.index + match[0].length);
              context.report({
                loc: { start, end },
                message:
                  "Disabling " +
                  RULE +
                  " needs a reason: `-- <why this cast is sound>`.",
              });
            }
          },
        };
      },
    },
  },
};
