// A service module (../serviceModule.mts) reaches the filesystem, paths,
// processes and the OS through Effect's platform services (FileSystem,
// Path, effect/process), never `node:fs`, `node:child_process`,
// `node:os` or `node:path` (EFFECT.md, section 7). Tests then stand in
// for the platform with a layer.
import { isServiceModule } from "../serviceModule.mts";
import type { Node, Rule } from "../types.mts";

const BUILTIN = /^(?:node:)?(?:fs|child_process|os|path)(?:\/.*)?$/;

type Source = Node<"ImportExpression">["source"] | null | undefined;

function sourceText(source: Source): string | null {
  return source?.type === "Literal" && typeof source.value === "string"
    ? source.value
    : null;
}

export default {
  meta: {
    docs: {
      description:
        "Disallow node:fs, node:child_process, node:os and node:path inside a service module.",
    },
  },
  create(context) {
    if (!isServiceModule(context.filename)) return {};
    const check = (
      node:
        | Node<"Program">["body"][number]
        | Node<"ImportExpression">
        | Node<"CallExpression">,
      source: Source,
    ) => {
      const text = sourceText(source);
      if (text === null || !BUILTIN.test(text)) return;
      context.report({
        node,
        message: `A service module reaches "${text}" through Effect's platform services (FileSystem, Path, effect/process) instead (EFFECT.md, section 7).`,
      });
    };
    return {
      ImportDeclaration(node) {
        check(node, node.source);
      },
      ExportNamedDeclaration(node) {
        check(node, node.source);
      },
      ExportAllDeclaration(node) {
        check(node, node.source);
      },
      ImportExpression(node) {
        check(node, node.source);
      },
      CallExpression(node) {
        const [first] = node.arguments;
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          first?.type !== "SpreadElement"
        ) {
          check(node, first);
        }
      },
    };
  },
} satisfies Rule;
