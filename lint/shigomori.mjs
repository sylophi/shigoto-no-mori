// An oxlint plugin with the repo's own rules.
//
// no-double-cast: no `x as unknown as T`. A double cast through unknown
// turns any value into any type with no check, and the bare `any` it
// stands in for is banned already (no-explicit-any).
//
// disable-needs-reason: every `oxlint-disable` comment ends in
// `-- <reason>`, so each cast, assertion or other exception the code
// keeps is one someone chose, with the reason next to it.

// A disable comment, and everything after the directive on its line.
const DISABLE = /\/[/*]\s*oxlint-disable(?:-next-line|-line)?\b([^\n]*)/g;

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
              const rest = match[1].replace(/\*\/\s*$/, "");
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
};
