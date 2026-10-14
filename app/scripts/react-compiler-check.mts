// Fails on a component or hook the React Compiler bails out of. The
// compiler skips such a function without a word, and the function then
// runs unmemoized: a callback ref or a row's props that were stable
// become new on every render. That is how the commit diff page lost
// its virtualized rows (V3.md, the alpha.4 diff rows record).
//
// It runs the compiler as the builds do (vite.reactCompiler.ts's preset
// and options) over app/renderer and packages/ui/src, and
// holds each bailout to react-compiler-bailouts.json: the ones that
// were there when this check came, each with its reason, to be fixed
// and taken off. A new one fails with its file, function and reason,
// and so does a listed one that compiles now, so the list only shrinks.
//
//   node scripts/react-compiler-check.mts           check
//   node scripts/react-compiler-check.mts --write   rewrite the list
//   node scripts/react-compiler-check.mts <file>... check those files
import { createRequire } from "node:module";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { reactCompilerPreset } from "@vitejs/plugin-react";
import type { LoggerEvent } from "babel-plugin-react-compiler";
import { REACT_COMPILER_OPTIONS } from "../vite.reactCompiler.ts";
import { appRoot, repoRoot } from "./lib/appRoot.mts";

type Node = {
  type: string;
  start?: number | null;
  id?: { name?: string } | null;
  key?: { name?: string } | null;
};
type NodePath = { node: Node; parentPath: NodePath | null };

// @babel/core ships no types and the app has no @types for it.
const babel = createRequire(import.meta.url)("@babel/core") as {
  parseSync: (code: string, options: object) => object;
  transformFromAstSync: (ast: object, code: string, options: object) => unknown;
  traverse: (ast: object, visitor: object) => void;
};

const ROOTS = ["app/renderer", "packages/ui/src"];
const LIST = join(appRoot, "scripts/react-compiler-bailouts.json");
// @vitejs/plugin-react's filter: a file without a component- or
// hook-shaped name never reaches the compiler.
const COMPILER_FILTER = /forwardRef|memo|\b(?:[A-Z]|use[A-Z0-9])/;

type Bailout = {
  file: string;
  function: string;
  category: string;
  reason: string;
};

const keyOf = (b: Bailout) => `${b.file} ${b.function} ${b.category}`;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : sources(path);
    return /\.(tsx?|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

// A function's name, by where it starts: its own, or the binding or
// key it is assigned to (a const arrow, memo(...), forwardRef(...)).
function namesByStart(ast: object): Map<number, string> {
  const names = new Map<number, string>();
  babel.traverse(ast, {
    Function(path: NodePath) {
      let name = path.node.id?.name;
      for (let up = path.parentPath; !name && up; up = up.parentPath) {
        if (up.node.type === "VariableDeclarator") name = up.node.id?.name;
        else if (/Property|Method/.test(up.node.type)) name = up.node.key?.name;
        else if (up.node.type !== "CallExpression") break;
      }
      if (name && path.node.start != null) names.set(path.node.start, name);
    },
  });
  return names;
}

function bailoutsIn(path: string): Bailout[] {
  const code = readFileSync(path, "utf8");
  if (!COMPILER_FILTER.test(code)) return [];
  const file = relative(repoRoot, path);
  const ast = babel.parseSync(code, {
    filename: path,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
  });
  const names = namesByStart(ast);
  const found = new Map<string, Bailout>();
  const logger = {
    logEvent(_filename: string | null, event: LoggerEvent) {
      if (event.kind !== "CompileError" && event.kind !== "PipelineError")
        return;
      const start = event.fnLoc?.start.index;
      const bailout = {
        file,
        function:
          (start === undefined ? undefined : names.get(start)) ??
          `<anonymous at line ${event.fnLoc?.start.line ?? "?"}>`,
        ...(event.kind === "CompileError"
          ? { category: event.detail.category, reason: event.detail.reason }
          : { category: "Pipeline", reason: event.data }),
      };
      found.set(keyOf(bailout), bailout);
    },
  };
  babel.transformFromAstSync(ast, code, {
    filename: path,
    babelrc: false,
    configFile: false,
    code: false,
    presets: [
      reactCompilerPreset({ ...REACT_COMPILER_OPTIONS, logger }).preset,
    ],
  });
  return [...found.values()];
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const only = args
  .filter((a) => !a.startsWith("--"))
  .map((a) => resolve(repoRoot, a))
  .filter((p) => ROOTS.some((r) => p.startsWith(join(repoRoot, r) + "/")));
const files =
  only.length > 0 ? only : ROOTS.flatMap((r) => sources(join(repoRoot, r)));
const checked = new Set(files.map((f) => relative(repoRoot, f)));

const found = files.flatMap(bailoutsIn);
const listed: Bailout[] = JSON.parse(readFileSync(LIST, "utf8"));

if (write) {
  if (only.length > 0)
    throw new Error("--write rewrites the whole list: give no files");
  const sorted = found.toSorted((a, b) => keyOf(a).localeCompare(keyOf(b)));
  writeFileSync(LIST, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`react-compiler: ${sorted.length} bailouts listed`);
  process.exit(0);
}

const listedKeys = new Set(listed.map(keyOf));
const foundKeys = new Set(found.map(keyOf));
const added = found.filter((b) => !listedKeys.has(keyOf(b)));
const gone = listed.filter(
  (b) => checked.has(b.file) && !foundKeys.has(keyOf(b)),
);

for (const b of added)
  console.error(
    `${b.file}: the React Compiler skips ${b.function} (${b.category}): ${b.reason}`,
  );
for (const b of gone)
  console.error(
    `${b.file}: ${b.function} compiles now, so take it off scripts/react-compiler-bailouts.json`,
  );
if (added.length > 0 || gone.length > 0) process.exit(1);
