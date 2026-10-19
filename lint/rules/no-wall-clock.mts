// The time comes through `Clock` or `DateTime`, never `Date.now()` or
// `new Date()` (EFFECT.md, section 7), in a service module anywhere
// (../serviceModule.mts) and in every module of the packages that run
// the host, the shell, the engine and the terminal `sm`. A test then
// moves it with `TestClock`. Effect's `Clock.currentTimeMillis` is the
// wall clock too, so elapsed time is `Clock.monotonicTimeNanos`.
import { isServiceModule } from "../serviceModule.mts";
import type { Rule } from "../types.mts";

const AREA =
  /(?:^|[\\/])(?:app[\\/](?:shared|host|main)|packages[\\/](?:engine|contracts|cli))[\\/]/;
const TEST = /(?:\.test\.m?tsx?$|[\\/]test[\\/])/;

function readsClockThroughEffect(filename: string): boolean {
  if (TEST.test(filename)) return false;
  return isServiceModule(filename) || AREA.test(filename);
}

const MESSAGE =
  "Read an instant through Clock.currentTimeMillis or DateTime.now, and elapsed time through Clock.monotonicTimeNanos (EFFECT.md, section 7)";

export default {
  meta: {
    docs: {
      description:
        "Disallow Date.now() and new Date() where the time comes through Clock.",
    },
  },
  create(context) {
    if (!readsClockThroughEffect(context.filename)) return {};
    return {
      // The current time; `new Date(at)` only formats one.
      NewExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "Date" &&
          node.arguments.length === 0
        ) {
          context.report({ node, message: `${MESSAGE}, not \`new Date()\`.` });
        }
      },
      MemberExpression(node) {
        const { object, property } = node;
        if (
          !node.computed &&
          object.type === "Identifier" &&
          object.name === "Date" &&
          property.type === "Identifier" &&
          property.name === "now"
        ) {
          context.report({ node, message: `${MESSAGE}, not \`Date.now\`.` });
        }
      },
    };
  },
} satisfies Rule;
