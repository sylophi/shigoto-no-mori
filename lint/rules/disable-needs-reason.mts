// Every diagnostic suppression says why, so each cast, assertion or
// other exception the code keeps is one someone chose, with the reason
// next to it:
//
//   // oxlint-disable-next-line no-await-in-loop -- <reason>
//   // eslint-disable-next-line react-hooks/exhaustive-deps -- <reason>
//   // @ts-expect-error <reason>
//
// A lint directive (oxlint's, or eslint's, which oxlint also honors)
// takes its reason after `--`. A TypeScript directive takes it as the
// text after the directive, the way tsc reads it.
import type { Rule } from "../types.mts";

const LINT = /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?\b(.*)$/s;
const TYPESCRIPT = /^\s*\/?\s*@ts-(?:expect-error|ignore|nocheck)\b(.*)$/s;

// What is wrong with this comment, or null when it is not an
// unexplained suppression.
function problem(comment: string): string | null {
  const lint = LINT.exec(comment);
  if (lint) {
    return /--\s*\S/.test(lint[1] ?? "")
      ? null
      : "A disable comment needs a reason: `-- <why this exception is sound>`.";
  }
  const typescript = TYPESCRIPT.exec(comment);
  if (typescript) {
    return /[\p{L}\p{N}]/u.test(typescript[1] ?? "")
      ? null
      : "A TypeScript suppression needs a reason after the directive: `// @ts-expect-error <why>`.";
  }
  return null;
}

export default {
  meta: {
    docs: {
      description:
        "Require a reason on every lint or TypeScript diagnostic suppression.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const message = problem(comment.value);
          if (message !== null) context.report({ loc: comment.loc, message });
        }
      },
    };
  },
} satisfies Rule;
