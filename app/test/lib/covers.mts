// The `// covers:` lines under test/, which `pnpm test --changed` adds
// to what `vitest related` follows through imports. The rules are in
// ../README.md.
import { readFileSync } from "node:fs";
import { join, matchesGlob, relative } from "node:path";
import { repoRoot, walk } from "./checkKit.mts";

const testDir = join(import.meta.dirname, "..");

const COVERS = /^[ \t]*\/\/ covers: (.+)$/gm;

// Every file under test/ that declares covers globs, repo-relative,
// with its globs.
export function coversLines(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(testDir, /\.mts$/)) {
    const globs = [...readFileSync(file, "utf8").matchAll(COVERS)].flatMap(
      ([, line = ""]) => line.split(/\s+/).filter(Boolean),
    );
    if (globs.length > 0) found.set(relative(repoRoot, file), globs);
  }
  return found;
}

// The files whose covers globs match one of `changed` (repo-relative
// paths): a proof among them runs, and so does every proof that
// imports a module among them.
export function coveringFiles(changed: string[]): string[] {
  return [...coversLines()]
    .filter(([, globs]) =>
      changed.some((path) => globs.some((glob) => matchesGlob(path, glob))),
    )
    .map(([file]) => file);
}
