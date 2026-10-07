// Effect is imported a module at a time, as a namespace from its
// subpath (EFFECT.md, section 2):
//
//   import * as Effect from "effect/Effect";
//
// never from the root barrel (`import { Effect } from "effect"`) and
// never as named values from a subpath, so a call site always reads
// `Effect.gen`, `Layer.effect`, `Schema.String`. A type-only import is
// fine: it brings in no value.
import type { Rule } from "../types.mts";

export default {
  meta: {
    docs: {
      description:
        'Require `import * as X from "effect/X"` for Effect modules.',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (source === "effect") {
          context.report({
            node,
            message:
              'Import Effect modules from their subpath as a namespace: `import * as Effect from "effect/Effect"`, not from "effect".',
          });
          return;
        }
        if (typeof source !== "string" || !source.startsWith("effect/")) {
          return;
        }
        if (node.importKind === "type") return;
        const named = node.specifiers.some(
          (specifier) =>
            specifier.type === "ImportDefaultSpecifier" ||
            (specifier.type === "ImportSpecifier" &&
              specifier.importKind !== "type"),
        );
        if (named) {
          const module = source.slice(source.lastIndexOf("/") + 1);
          context.report({
            node,
            message: `Import "${source}" as a namespace: \`import * as ${module} from "${source}"\`.`,
          });
        }
      },
    };
  },
} satisfies Rule;
