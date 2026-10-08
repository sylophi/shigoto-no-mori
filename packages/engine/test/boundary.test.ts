// The engine runs in the host under Node and in the terminal binary
// under Bun, so it may reach Node's APIs, Effect and the contracts, and
// nothing else: no Electron, nothing from the app, no Bun global. The
// package graph holds most of it, since a dependency the engine does
// not declare cannot resolve, and this proof holds the rest: what the
// package may declare, and what its sources may name.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { it } from "vitest";

const root = join(import.meta.dirname, "..");
const src = join(root, "src");

const isAllowedDependency = (name: string) =>
  name === "effect" ||
  name.startsWith("@effect/") ||
  name === "@shigomori/contracts";

const isAllowedSpecifier = (specifier: string, fileDir: string) =>
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

// `from "x"` (imports and re-exports), `import("x")` and `import "x"`.
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
const BUN_GLOBAL = /\bBun\s*\./;

it("declares only Effect and the contracts", () => {
  const manifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const outside = Object.keys(manifest.dependencies ?? {}).filter(
    (name) => !isAllowedDependency(name),
  );
  assert.deepEqual(outside, []);
});

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
    for (const [, specifier = ""] of code.matchAll(IMPORT_SPECIFIER)) {
      if (!isAllowedSpecifier(specifier, dirname(file))) {
        failures.push(`${rel} imports "${specifier}"`);
      }
    }
    if (BUN_GLOBAL.test(code)) failures.push(`${rel} reaches the Bun global`);
  }
  assert.deepEqual(failures, []);
});
