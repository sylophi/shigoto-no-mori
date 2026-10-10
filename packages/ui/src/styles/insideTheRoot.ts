// A PostCSS plugin for every build of this package's stylesheet (the
// app's, the web client's, the fake host's, the marketing site's), so
// nothing it compiles to selects outside a theme root. Tailwind writes
// its preflight on the page's elements, its theme's variables on :root
// and :host, and its @property fallbacks on every element, and has no
// setting for where. This moves those rules onto the theme root and
// what is inside it. It rewrites only rules in a cascade layer, which
// is all Tailwind writes: a page's own unlayered rules (the app's html
// and body) stay the page's.
//
//   :root, :host, html     ->  :where([data-theme-scope])
//   *, h1, ::backdrop      ->  *:where([data-theme-scope], [data-theme-scope] *), ...
//
// :where() adds no specificity, so the cascade inside a root is as
// before. A selector whose leftmost part names a class or a data-
// attribute already reaches only the package's own markup and stays.

const ROOT = "[data-theme-scope]";
const AT_ROOT = `:where(${ROOT})`;
const IN_ROOT = `:where(${ROOT}, ${ROOT} *)`;
const PAGE = /^(?::root|:host|html|body)(?![\w-])/;
const TYPE = /^(?:\*|[a-zA-Z][\w-]*)/;

// The part of a selector before its first combinator.
function leftmost(selector: string): string {
  let depth = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i] ?? "";
    if (c === "\\") i++;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && /[\s>+~]/.test(c)) return selector.slice(0, i);
  }
  return selector;
}

// The selectors in a list, split at its top-level commas.
function split(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i] ?? "";
    if (c === "\\") i++;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && c === ",") {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  return [...parts, list.slice(start).trim()];
}

// Whether a compound names a class or a data- attribute of its own,
// outside any :not() or :has(), or is an :is() or :where() of
// selectors that each do.
function anchored(compound: string): boolean {
  const group = /^:(?:is|where)\((.*)\)$/.exec(compound);
  if (group) return split(group[1] ?? "").every((s) => anchored(leftmost(s)));
  let depth = 0;
  for (let i = 0; i < compound.length; i++) {
    const c = compound[i] ?? "";
    if (c === "\\") i++;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && c === ".") return true;
    else if (depth === 0 && compound.startsWith("[data-", i)) return true;
  }
  return false;
}

function scopeToRoot(selector: string): string {
  const s = selector.trim();
  const compound = leftmost(s);
  if (compound.includes(ROOT) || anchored(compound)) return s;
  const page = PAGE.exec(s);
  if (page) return AT_ROOT + s.slice(page[0].length);
  const type = TYPE.exec(s)?.[0] ?? "";
  return type + IN_ROOT + s.slice(type.length);
}

// The slice of PostCSS's node the plugin reads, so the package needs no
// PostCSS of its own: the build's hands it the real one.
interface CssNode {
  type: string;
  name?: string;
  parent?: CssNode | undefined;
}
interface CssRule extends CssNode {
  selectors: string[];
}

function within(node: CssNode, test: (at: CssNode) => boolean): boolean {
  for (let at = node.parent; at; at = at.parent) {
    if (at.type === "atrule" && test(at)) return true;
  }
  return false;
}

export function insideTheRoot() {
  return {
    postcssPlugin: "shigomori-inside-the-root",
    Rule(rule: CssRule) {
      if (!within(rule, (at) => at.name === "layer")) return;
      if (within(rule, (at) => at.name?.endsWith("keyframes") === true)) {
        return;
      }
      rule.selectors = [...new Set(rule.selectors.map(scopeToRoot))];
    },
  };
}
insideTheRoot.postcss = true as const;
