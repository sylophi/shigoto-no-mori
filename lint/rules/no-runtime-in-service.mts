// A service module (../serviceModule.mts) never runs an effect: no
// `ManagedRuntime`, no `Effect.runPromise` or its kin. Running belongs at
// the edges, a React hook, an Electron callback, the terminal
// entrypoint, a Promise adapter (EFFECT.md, section 3).
import { isServiceModule } from "../serviceModule.mts";
import type { Rule } from "../types.mts";

const RUNNERS = new Set([
  "runPromise",
  "runPromiseExit",
  "runSync",
  "runSyncExit",
  "runFork",
  "runCallback",
]);

const message =
  "A service module returns effects and never runs them. Run it at the edge (EFFECT.md, section 3).";

export default {
  meta: {
    docs: {
      description: "Disallow a runtime or `run*` call inside a service module.",
    },
  },
  create(context) {
    if (!isServiceModule(context.filename)) return {};
    return {
      ImportDeclaration(node) {
        if (node.source.value === "effect/ManagedRuntime") {
          context.report({ node, message });
        }
      },
      MemberExpression(node) {
        const { property } = node;
        if (
          !node.computed &&
          property.type === "Identifier" &&
          RUNNERS.has(property.name)
        ) {
          context.report({ node, message });
        }
      },
    };
  },
} satisfies Rule;
