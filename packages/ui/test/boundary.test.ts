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
import { it } from "vitest";
import pkg from "../package.json" with { type: "json" };

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
// out by the viewport's width: Tailwind's sm: to 2xl: are media
// queries, and the window's own width is a container's (`@min-*`).
const GLOBAL_READ =
  /\b(?:window|document)\.[A-Za-z]|(?<![.\w])(?:getComputedStyle|matchMedia)\(|(?<![\w@[-])(?:max-)?(?:sm|md|lg|xl|2xl):[\w[]/;

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
      const hit = GLOBAL_READ.exec(code);
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
    const css = readFileSync(join(styles, name), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/url\([^)]*\)/g, "");
    // Only selectors: the text before each `{`.
    for (const [, selector = ""] of css.matchAll(/([^{};]+)\{/g)) {
      if (PAGE_SELECTOR.test(selector) || VIEWPORT_WIDTH.test(selector)) {
        failures.push(`${name}: ${selector.trim()}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});
