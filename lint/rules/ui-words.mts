// The words the app shows a person keep to app/DESIGN.md's "Words":
// one spelling of a thing, wherever it is said. This holds the drifts a
// pattern can name, in every string and JSX text of the views and the
// renderer. A word that needs a judgment (Delete or Remove) stays with
// DESIGN.md. A key's glyph is one more: typed at a call site it shows a
// Mac's key on every platform.
import type { Node, Rule } from "../types.mts";

type Shown = Node<"Literal"> | Node<"TemplateElement"> | Node<"JSXText">;

const AREA = /(?:^|[\\/])(?:packages[\\/]ui[\\/]src|app[\\/]renderer)[\\/]/;
const NOT_SHOWN = /(?:\.test\.m?tsx?$|[\\/](?:test|scenes|fixtures)[\\/])/;
// Where a key's label is written down, for every other file to take.
const KEY_LABELS = /[\\/]lib[\\/](?:keymap|keys)\.ts$/;
const KEY_GLYPH = /[↩⇥⌫⌦⇧⌘⌥⌃]/;

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
    const spellsKeys = KEY_LABELS.test(filename);
    const check = (node: Shown, text: unknown) => {
      if (typeof text !== "string") return;
      for (const [pattern, message] of WORDS) {
        if (pattern.test(text)) context.report({ node, message });
      }
      if (!spellsKeys && KEY_GLYPH.test(text)) {
        context.report({
          node,
          message:
            "A key is written as its platform prints it: take the label from the keymap, or from KEYS (lib/keys.ts) for a key no one rebinds.",
        });
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
