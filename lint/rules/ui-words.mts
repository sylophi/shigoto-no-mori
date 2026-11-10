// The words the app shows a person keep to app/DESIGN.md's "Words":
// one spelling of a thing, wherever it is said. This holds the drifts a
// pattern can name, in every string and JSX text of the views and the
// renderer. A word that needs a judgment (Delete or Remove) stays with
// DESIGN.md.
import type { Node, Rule } from "../types.mts";

type Shown = Node<"Literal"> | Node<"TemplateElement"> | Node<"JSXText">;

const AREA = /(?:^|[\\/])(?:packages[\\/]ui[\\/]src|app[\\/]renderer)[\\/]/;
const NOT_SHOWN = /(?:\.test\.m?tsx?$|[\\/](?:test|scenes|fixtures)[\\/])/;

const WORDS: readonly (readonly [RegExp, string])[] = [
  [
    /(?<![./])\.\.\.(?![./\w])/,
    "An ellipsis is one character, “…”, not three dots.",
  ],
  [/\bShigomori\b/, "The app's name is “Shigoto no Mori”."],
  [/\bmain checkout\b/i, "A project's own checkout is its “primary checkout”."],
  [/\b(?:could not|cannot)\b/i, "Contract it: “couldn't”, “can't”."],
];

export default {
  meta: {
    docs: {
      description:
        "Hold the strings a person reads to the spellings in app/DESIGN.md.",
    },
  },
  create(context) {
    const { filename } = context;
    if (!AREA.test(filename) || NOT_SHOWN.test(filename)) return {};
    const check = (node: Shown, text: unknown) => {
      if (typeof text !== "string") return;
      for (const [pattern, message] of WORDS) {
        if (pattern.test(text)) context.report({ node, message });
      }
    };
    return {
      Literal(node) {
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked);
      },
      JSXText(node) {
        check(node, node.value);
      },
    };
  },
} satisfies Rule;
