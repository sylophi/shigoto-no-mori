// Durable proof for how a commit picks its proofs (`pnpm test
// --changed`, run.mts): `vitest related` follows imports, and the
// `// covers:` lines (lib/covers.mts) add what a proof depends on
// without importing it. The rules are in README.md.
//
// Asserts:
// - every covers glob matches a tracked file, so a moved fixture or a
//   typo can't leave a proof unreachable in silence
// - files reached only through covers lines pick the files that
//   declare them, a proof or a module the proofs import
//
// Run: pnpm test proof-selection.
//
// covers: app/test/**
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { matchesGlob } from "node:path";
import { it } from "vitest";
import { repoRoot } from "./lib/checkKit.mts";
import { coveringFiles, coversLines } from "./lib/covers.mts";

const tracked = execFileSync("git", ["ls-files"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

it("every covers glob matches a tracked file", () => {
  const stale = [...coversLines()].flatMap(([file, globs]) =>
    globs
      .filter((glob) => !tracked.some((p) => matchesGlob(p, glob)))
      .map((glob) => `${file}: ${glob}`),
  );
  assert.deepEqual(stale, []);
});

it("files reached only through covers lines pick their declarers", () => {
  // A path, and the files its covers lines must hand to vitest related.
  const expect: [string, string[]][] = [
    // A build of sm, through the module every proof that runs it loads.
    ["packages/cli/src/main.ts", ["app/test/lib/smBinary.mts"]],
    ["file-sync/engine.go", ["app/test/mirror.mts"]],
    // A directory scan, a lockfile read.
    ["app/renderer/App.tsx", ["app/test/host-boundary.mts"]],
    ["pnpm-lock.yaml", ["app/test/theme-contract.mts", "app/test/dmg-art.mts"]],
    // The config every proof runs under.
    ["app/vitest.config.ts", ["app/test/lib/checkKit.mts"]],
  ];
  for (const [path, picks] of expect) {
    const got = coveringFiles([path]);
    for (const file of picks) {
      assert.ok(got.includes(file), `${path} picks ${file}`);
    }
  }
  assert.deepEqual(coveringFiles(["hub/src/worker.ts"]), []);
});
