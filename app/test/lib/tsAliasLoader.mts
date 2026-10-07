// A minimal Node module-resolution hook so a plain script can import
// the app's TypeScript directly (Node 22.18+ strips types on
// its own, but it does not know the tsconfig path aliases or resolve
// extensionless specifiers). Two jobs:
//   1. Map the repo's import aliases (@shared, @host, @) to their dirs.
//   2. Resolve an extensionless specifier to its .ts/.mts file (or an
//      index file), the way the bundler does.
// Registered via test/lib/register-ts-alias.mts. Kept dependency
// free and used only by the scripts that run app modules
// (scripts/fetch-villager-data.mts, test/bench), never by the app
// build or the proofs, which vitest resolves.
import { existsSync, statSync } from "node:fs";
import type { ResolveHook } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = join(import.meta.dirname, "..", "..");

// Alias prefix to app-relative directory. Order does not matter: the
// prefixes are distinct.
const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["@shared/", "shared"],
  ["@host/", "host"],
  ["@/", "renderer"],
];

const CANDIDATE_SUFFIXES = [".ts", ".mts", ".js", ".mjs"];

// Given a resolved base path with no extension, find the real file the
// bundler would have picked: the base as-is, then a source extension,
// then an index file inside a directory of that name.
function withResolvedExtension(base: string): string | null {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const suffix of CANDIDATE_SUFFIXES) {
    if (existsSync(base + suffix)) return base + suffix;
  }
  for (const suffix of CANDIDATE_SUFFIXES) {
    const indexPath = join(base, `index${suffix}`);
    if (existsSync(indexPath)) return indexPath;
  }
  return null;
}

// How the loader reads a specifier it resolves itself: the directory
// it is rooted at (an alias's, or null for the importing file's) and
// the path under it. Null for one left to node (a package, a builtin).
function appSpecifier(
  specifier: string,
): { dir: string | null; rest: string } | null {
  for (const [prefix, dir] of ALIASES) {
    if (specifier.startsWith(prefix)) {
      return { dir: join(appRoot, dir), rest: specifier.slice(prefix.length) };
    }
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return { dir: null, rest: specifier };
  }
  return null;
}

// The app source file an import names by the two rules above: an
// alias, or a relative specifier from the importing file at
// `parentPath`. Null for one left to node and for one that names no
// file.
function resolveSource(
  specifier: string,
  parentPath: string | undefined,
): string | null {
  const app = appSpecifier(specifier);
  if (app === null) return null;
  const dir =
    app.dir ?? (parentPath === undefined ? null : dirname(parentPath));
  return dir === null
    ? null
    : withResolvedExtension(resolvePath(dir, app.rest));
}

export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  const parentPath = context.parentURL?.startsWith("file:")
    ? fileURLToPath(context.parentURL)
    : undefined;
  const file = resolveSource(specifier, parentPath);
  if (file !== null) {
    // A bundler-style JSON import (host/lib/worktrees/names.ts): the
    // TS graph writes it bare, but Node's ESM loader refuses JSON
    // without the `type: "json"` attribute, so supply it here.
    if (file.endsWith(".json")) {
      return {
        url: pathToFileURL(file).href,
        importAttributes: { type: "json" },
        shortCircuit: true,
      };
    }
    // A relative specifier that already names its file is left to node.
    const named =
      specifier.startsWith(".") &&
      parentPath !== undefined &&
      file === resolvePath(dirname(parentPath), specifier);
    if (!named) return { url: pathToFileURL(file).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
};
