// The engine runs in the host under Node and in the terminal binary
// under Bun, so it may reach Node's APIs, Effect and the contracts, and
// nothing else: no Electron, nothing from the app, no Bun global. The
// package graph holds most of it, since a dependency the engine does
// not declare cannot resolve, and this proof holds what its sources
// may name.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { it } from "vitest";

const root = join(import.meta.dirname, "..");
const src = join(root, "src");

const isAllowed = (specifier: string, fileDir: string) =>
  specifier.startsWith(".")
    ? resolve(fileDir, specifier).startsWith(src + sep)
    : specifier.startsWith("node:") ||
      specifier === "effect" ||
      specifier.startsWith("effect/") ||
      specifier.startsWith("@effect/") ||
      specifier.startsWith("@shigomori/contracts/");

// Comments go first, so prose may name anything.
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// `from "x"` (imports and re-exports), `import("x")`, `require("x")`,
// and `import "x"` at the start of a statement. A `from` inside a string
// or after a dot (`"from"`, `x.from "`) is not a keyword.
const IMPORT_SPECIFIER =
  /(?:(?<![\w$."'`])\bfrom\s*|\b(?:import|require)\s*\(\s*|^\s*import\s*)["']([^"']+)["']/gm;

const specifiersOf = (code: string) =>
  [...code.matchAll(IMPORT_SPECIFIER)].map(([, specifier = ""]) => specifier);
const BUN_GLOBAL = /\bBun\b/;

it("imports only Node, Effect and the contracts, and no Bun global", () => {
  const failures: string[] = [];
  const entries = existsSync(src)
    ? readdirSync(src, { recursive: true, withFileTypes: true })
    : [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const file = join(entry.parentPath, entry.name);
    const rel = relative(root, file);
    const code = stripComments(readFileSync(file, "utf8"));
    for (const specifier of specifiersOf(code)) {
      if (!isAllowed(specifier, dirname(file))) {
        failures.push(`${rel} imports "${specifier}"`);
      }
    }
    if (BUN_GLOBAL.test(code)) failures.push(`${rel} reaches the Bun global`);
  }
  assert.deepEqual(failures, []);
});

it("reads every import form, and no string that says from", () => {
  const code = [
    'import * as A from "a";',
    "import { b } from 'b';",
    'import type { C } from "c";',
    'import d, { e } from"d";',
    'export * from "e";',
    'export { f } from "f";',
    'import "g";',
    'const h = await import("h");',
    'const i = require( "i" );',
    'import {\n  j,\n} from "j";',
    'const flags = ["to", "from"] as const;',
    "const keys = { to: 1, from: 2 };",
    'const said = x.from "nope";',
    "const line = `--from <device>`;",
  ].join("\n");
  assert.deepEqual(specifiersOf(code), [
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
  ]);
});
