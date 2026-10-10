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
