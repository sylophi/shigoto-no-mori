// Which proofs a change reaches, and whether it reaches the hub, for
// run.mts. The rules are in ../README.md.
import { readdirSync, readFileSync } from "node:fs";
import { join, matchesGlob, relative, resolve } from "node:path";
import { repoRoot, walk } from "./checkKit.mts";
import { isAppSpecifier, resolveSource } from "./tsAliasLoader.mts";

const testDir = join(import.meta.dirname, "..");
const RUNNER = "run";
const SUFFIX = ".mts";

// The proofs: the scripts at the top of test/, but for the runner.
export function proofNames(): string[] {
  return readdirSync(testDir)
    .filter((file) => file.endsWith(SUFFIX) && file !== RUNNER + SUFFIX)
    .map((file) => file.slice(0, -SUFFIX.length))
    .toSorted();
}

// The script `name` names under test/ (a proof, or a path such as
// bench/wire).
export function proofFile(name: string): string {
  return join(testDir, name + SUFFIX);
}

// Loaded into every proof by run.mts, ahead of its own imports.
export const PRELOAD = join(testDir, "lib", "register-ts-alias.mts");

const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;

// `import … from` and `export … from` (group 1 is set when the whole
// statement is `type`), a bare `import "…"` and a dynamic `import("…")`.
// Statements are matched at the start of a line, which keeps prose in
// comments out. The clause between the keyword and `from` may hold line
// and block comments, quotes and all.
const FROM =
  /^[ \t]*(?:import|export)(\s+type\b)?(?:[^;'"/]|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*?\bfrom\s*["']([^"']+)["']/gm;
const BARE = /^[ \t]*import\s*["']([^"']+)["']/gm;
const DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const COVERS = /^[ \t]*\/\/ covers: (.+)$/gm;

// Exported for proof-selection.
export function importedSpecifiers(source: string, types: boolean): string[] {
  const found: string[] = [];
  for (const [, type, spec] of source.matchAll(FROM)) {
    if ((types || type === undefined) && spec !== undefined) found.push(spec);
  }
  for (const pattern of [BARE, DYNAMIC]) {
    for (const [, spec] of source.matchAll(pattern)) {
      if (spec !== undefined) found.push(spec);
    }
  }
  return found;
}

function coversOf(source: string): string[] {
  return [...source.matchAll(COVERS)].flatMap(([, globs = ""]) =>
    globs.split(/\s+/).filter(Boolean),
  );
}

export type Deps = {
  // Repo-relative paths of the entry files and every file they load.
  files: Set<string>;
  // The covers globs those files declare.
  covers: string[];
  // App specifiers (an alias or a relative path) that name no file.
  unresolved: string[];
};

// The import graph from `entries`. Node's view leaves type-only imports
// out, since it never loads them. tsc's view (`types`) keeps them.
function importGraph(entries: string[], types: boolean): Deps {
  const deps: Deps = { files: new Set(), covers: [], unresolved: [] };
  const pending = [...entries];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    const rel = relative(repoRoot, file);
    if (deps.files.has(rel)) continue;
    deps.files.add(rel);
    if (!SOURCE.test(file)) continue;
    const source = readFileSync(file, "utf8");
    deps.covers.push(...coversOf(source));
    for (const spec of importedSpecifiers(source, types)) {
      const target = resolveSource(spec, file);
      if (target !== null) pending.push(target);
      else if (isAppSpecifier(spec)) deps.unresolved.push(`${rel}: ${spec}`);
    }
  }
  return deps;
}

const depsCache = new Map<string, Deps>();

// What the proof `name` loads, preload included, and its covers globs.
export function proofDeps(name: string): Deps {
  let deps = depsCache.get(name);
  if (deps === undefined) {
    deps = importGraph([proofFile(name), PRELOAD], false);
    depsCache.set(name, deps);
  }
  return deps;
}

// Whether a change to `changed` (repo-relative paths) reaches the
// proof `name`.
export function touches(name: string, changed: string[]): boolean {
  const { files, covers } = proofDeps(name);
  return changed.some(
    (path) => files.has(path) || covers.some((glob) => matchesGlob(path, glob)),
  );
}

// Whether a change reaches the hub's checks (README.md).
export function reachesHub(changed: string[]): boolean {
  const hubDir = join(repoRoot, "hub");
  const sources = [...walk(join(hubDir, "src"), SOURCE)];
  sources.push(...walk(join(hubDir, "test"), SOURCE));
  const { files } = importGraph(sources, true);
  return changed.some((path) => path.startsWith("hub/") || files.has(path));
}

// Paths as given (repo-relative, the way lefthook passes staged files,
// or absolute) to the repo-relative form the deps use.
export function repoPaths(paths: string[]): string[] {
  return paths.map((path) => relative(repoRoot, resolve(repoRoot, path)));
}
