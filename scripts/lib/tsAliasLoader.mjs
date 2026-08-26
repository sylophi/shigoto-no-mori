// A minimal Node module-resolution hook so a plain check script can
// import the app's TypeScript directly (Node 22.18+ strips types on
// its own, but it does not know the tsconfig path aliases or resolve
// extensionless specifiers). Two jobs:
//   1. Map the repo's import aliases (@shared, @host, @) to their dirs.
//   2. Resolve an extensionless specifier to its .ts/.mts file (or an
//      index file), the way the bundler does.
// Registered via scripts/lib/register-ts-alias.mjs. Kept dependency
// free and used only by checks, never by the app build.
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Alias prefix to repo-relative directory. Order does not matter: the
// prefixes are distinct.
const ALIASES = [
  ["@shared/", "shared"],
  ["@host/", "host"],
  ["@/", "renderer"],
];

const CANDIDATE_SUFFIXES = [".ts", ".mts", ".js", ".mjs"];

// Given a resolved base path with no extension, find the real file the
// bundler would have picked: the base as-is, then a source extension,
// then an index file inside a directory of that name.
function withResolvedExtension(base) {
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

export async function resolve(specifier, context, nextResolve) {
  for (const [prefix, dir] of ALIASES) {
    if (specifier.startsWith(prefix)) {
      const base = resolvePath(repoRoot, dir, specifier.slice(prefix.length));
      const file = withResolvedExtension(base);
      if (file !== null) {
        return { url: pathToFileURL(file).href, shortCircuit: true };
      }
    }
  }
  // Extensionless relative imports inside the TS graph (./contract).
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL !== undefined &&
    context.parentURL.startsWith("file:")
  ) {
    const base = resolvePath(
      dirname(fileURLToPath(context.parentURL)),
      specifier,
    );
    // A bundler-style JSON import (host/lib/worktrees/names.ts): the
    // TS graph writes it bare, but Node's ESM loader refuses JSON
    // without the `type: "json"` attribute, so supply it here.
    if (base.endsWith(".json") && existsSync(base)) {
      return {
        url: pathToFileURL(base).href,
        importAttributes: { type: "json" },
        shortCircuit: true,
      };
    }
    const file = withResolvedExtension(base);
    if (file !== null && file !== base) {
      return { url: pathToFileURL(file).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
