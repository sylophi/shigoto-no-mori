// The views draw in a desktop window, a browser tab, the marketing
// site's build and the scenes proof under Node, so they may reach the
// dependencies this package declares, the contracts and each other,
// and nothing else: nothing from the app, no Node, no Electron, no host
// bridge. The package graph holds most of it, since a module the
// package does not declare cannot resolve, and this proof holds what
// its sources may name.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { build, type Rollup } from "vite";
import { it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { insideTheRoot } from "../src/styles/insideTheRoot.ts";

const root = join(import.meta.dirname, "..");
const src = join(root, "src");
const dependencies = Object.keys(pkg.dependencies);

const isAllowed = (specifier: string, fileDir: string) =>
  specifier.startsWith(".")
    ? resolve(fileDir, specifier).startsWith(src + sep)
    : dependencies.some(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      );

// Comments go first, so prose may name anything.
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// The specifiers of import and export statements (which start a line,
// or follow a semicolon, end at theirs and hold no parentheses),
// side-effect imports and `import("x")`. Matching statements rather than every `from "x"`
// keeps JSX text like `Pre-fills "Branched from" when…` out.
const IMPORT_SPECIFIERS = [
  /(?:^|;)\s*(?:import|export)\s[^;()]*?(?<![\w$."'`-])from\s*["']([^"']+)["']/gm,
  /^\s*import\s*["']([^"']+)["']/gm,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

const specifiersOf = (code: string) =>
  IMPORT_SPECIFIERS.flatMap((pattern) =>
    [...code.matchAll(pattern)].map(([, specifier = ""]) => specifier),
  );

const HOST_BRIDGE = /\bwindow\.api\b/;

it("imports only its dependencies, and never the host bridge", () => {
  const failures: string[] = [];
  for (const entry of readdirSync(src, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    const rel = relative(root, file);
    const code = stripComments(readFileSync(file, "utf8"));
    for (const specifier of specifiersOf(code)) {
      if (!isAllowed(specifier, dirname(file))) {
        failures.push(`${rel} imports "${specifier}"`);
      }
    }
    if (HOST_BRIDGE.test(code)) failures.push(`${rel} reaches window.api`);
  }
  assert.deepEqual(failures, []);
});

// A view or a primitive reads no global: what it needs of the page comes
// through an element's own document (`el.ownerDocument`), and a listener
// on the window lives in a hook that owns it (src/hooks). So a view
// draws the same in a frame, a scene or another window. Nor does it lay
// out by the viewport: Tailwind's sm: to 2xl: are media queries on its
// width, and the window's own width is a container's (`@min-*`). Its
// height is the root's, or a share of it in `cqh`, never a vh unit's.
const GLOBAL_READ =
  /\b(?:window|document)\.[A-Za-z]|(?<![.\w])(?:getComputedStyle|matchMedia)\(|(?<![\w@[-])(?:max-)?(?:sm|md|lg|xl|2xl):[\w[]/;
const VIEWPORT_HEIGHT =
  /(?:\d|\b(?:min-|max-)?h-)(?:d|s|l)?vh\b|\b(?:min-|max-)?h-screen\b/;

it("keeps globals out of the views and primitives", () => {
  const failures: string[] = [];
  for (const dir of ["views", "primitives"]) {
    for (const entry of readdirSync(join(src, dir), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
      const file = join(entry.parentPath, entry.name);
      const code = stripComments(readFileSync(file, "utf8"));
      const hit = GLOBAL_READ.exec(code) ?? VIEWPORT_HEIGHT.exec(code);
      if (hit) failures.push(`${relative(root, file)} reads ${hit[0]}`);
    }
  }
  assert.deepEqual(failures, []);
});

// The stylesheets theme the root element they are given (data-theme-scope)
// and what is inside it, never the page: no rule selects :root, html or
// body, so a scene or a frame wears its own theme. Widths are the
// window's, a container query's, never a media query on the viewport.
const PAGE_SELECTOR = /(?:^|[\s,{}>+~(])(?::root|html|body)(?![\w-])/;
const VIEWPORT_WIDTH = /@media[^{]*\b(?:min-|max-)?width\b/;

it("keeps the stylesheets inside the root element", () => {
  const failures: string[] = [];
  const styles = join(src, "styles");
  for (const name of readdirSync(styles)) {
    if (!name.endsWith(".css")) continue;
    const source = readFileSync(join(styles, name), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    // An image is a file the bundlers emit, so a page with a strict
    // content security policy (the marketing site's) can draw it.
    if (/url\(\s*["']?data:/.test(source)) {
      failures.push(`${name} carries a data: URL`);
    }
    const css = source.replace(/url\([^)]*\)/g, "");
    // Only selectors: the text before each `{`.
    for (const [, selector = ""] of css.matchAll(/([^{};]+)\{/g)) {
      if (PAGE_SELECTOR.test(selector) || VIEWPORT_WIDTH.test(selector)) {
        failures.push(`${name}: ${selector.trim()}`);
      }
    }
    const height = VIEWPORT_HEIGHT.exec(css);
    if (height) failures.push(`${name} sizes by the viewport: ${height[0]}`);
  }
  assert.deepEqual(failures, []);
});

// What a selector's leftmost compound is, up to its first combinator.
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

// A selector list split at its top-level commas.
function selectorsOf(list: string): string[] {
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

// Whether a selector can match only inside a theme root, or only what
// wears the package's own markup: its leftmost compound is in a root,
// or names a class or a data- attribute of its own (or is an :is() of
// such selectors).
function staysInside(selector: string): boolean {
  const compound = leftmost(selector);
  if (compound.includes("[data-theme-scope]")) return true;
  const group = /^:(?:is|where)\((.*)\)$/.exec(compound);
  if (group) return selectorsOf(group[1] ?? "").every(staysInside);
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

// The stylesheets as every build compiles them (Tailwind, then the
// root's PostCSS plugin), since Tailwind writes rules of its own (the
// preflight, the theme's variables, the @property fallbacks) that no
// source shows.
async function compiled(entry: string): Promise<string> {
  const output = (await build({
    configFile: false,
    logLevel: "silent",
    root,
    plugins: [tailwindcss()],
    css: { postcss: { plugins: [insideTheRoot()] } },
    build: {
      write: false,
      cssMinify: false,
      rollupOptions: { input: join(src, "styles", entry) },
    },
  })) as Rollup.RollupOutput;
  return output.output
    .filter((file) => file.fileName.endsWith(".css"))
    .map((file) => (file.type === "asset" ? String(file.source) : ""))
    .join("\n");
}

it("compiles to rules that stay inside the root element", async () => {
  const failures: string[] = [];
  const entries = ["index.css", "fonts.css"];
  const sheets = await Promise.all(entries.map(compiled));
  for (const [i, sheet] of sheets.entries()) {
    const entry = entries[i];
    const css = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
    let keyframes = 0;
    for (const [, prelude = "", brace] of css.matchAll(/([^{};]*)([{}])/g)) {
      const head = prelude.trim();
      if (brace === "}") {
        if (keyframes > 0) keyframes--;
        continue;
      }
      if (keyframes > 0) {
        keyframes++;
        continue;
      }
      if (/^@[\w-]*keyframes\b/.test(head)) keyframes = 1;
      if (head.startsWith("@") || head === "") continue;
      for (const selector of selectorsOf(head)) {
        if (!staysInside(selector)) failures.push(`${entry}: ${selector}`);
      }
    }
  }
  assert.deepEqual(failures, []);
}, 60_000);
