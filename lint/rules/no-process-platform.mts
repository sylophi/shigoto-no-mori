// The OS is read in one place, packages/engine/src/platform.ts, and
// what differs by it picks its case from byPlatform's table, so a new
// OS is a type error at each place that differs. Everywhere else in the
// code the app runs (the shell, the host, the engine, the terminal `sm`)
// `process.platform` and `os.platform()` are refused. Build scripts and
// tests read the machine they run on.
import type { Rule } from "../types.mts";

const AREA =
  /(?:^|[\\/])(?:app[\\/](?:shared|host|main|headless)|packages[\\/](?:engine|contracts|cli|ui)[\\/]src)[\\/]/;
const TEST = /(?:\.test\.m?tsx?$|[\\/]test[\\/])/;
const PLATFORM_MODULE = /packages[\\/]engine[\\/]src[\\/]platform\.ts$/;

const MESSAGE =
  "Read the OS through @shigomori/engine/platform (current, byPlatform)";

export default {
  meta: {
    docs: {
      description:
        "Disallow process.platform and os.platform() outside the engine's platform module.",
    },
  },
  create(context) {
    const { filename } = context;
    if (!AREA.test(filename) || TEST.test(filename)) return {};
    if (PLATFORM_MODULE.test(filename)) return {};
    // The names node:os is imported under whole (`import * as os`).
    const osNamespaces = new Set<string>();
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "node:os" && node.source.value !== "os") {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") {
            osNamespaces.add(specifier.local.name);
          } else if (
            specifier.imported.type === "Identifier" &&
            specifier.imported.name === "platform"
          ) {
            context.report({
              node: specifier,
              message: `${MESSAGE}, not node:os's \`platform\`.`,
            });
          }
        }
      },
      MemberExpression(node) {
        const { object, property } = node;
        if (
          node.computed ||
          object.type !== "Identifier" ||
          property.type !== "Identifier" ||
          property.name !== "platform"
        ) {
          return;
        }
        if (object.name === "process" || osNamespaces.has(object.name)) {
          context.report({
            node,
            message: `${MESSAGE}, not \`${object.name}.platform\`.`,
          });
        }
      },
    };
  },
} satisfies Rule;
