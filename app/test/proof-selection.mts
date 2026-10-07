// Durable proof for how a commit picks its proofs and whether it runs
// the hub's check (lib/proofDeps.mts, behind `pnpm test --changed`).
// The rules are in README.md.
//
// Asserts:
// - every app import in a proof's graph names a file, and an import
//   clause with comments in it is still read, so the walk misses
//   nothing node loads
// - every covers glob matches a tracked file, so a moved fixture or a
//   typo can't leave a proof unreachable in silence
// - files reached only through the loader, deep imports or covers
//   lines pick their proofs, and a type-only import picks none
// - the hub's check runs for the app files the hub imports, however
//   deep, and not for the rest of the app
//
// Run: pnpm test proof-selection.
//
// covers: app/test/**
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { matchesGlob } from "node:path";
import { makeProof, repoRoot } from "./lib/checkKit.mts";
import {
  importedSpecifiers,
  proofDeps,
  proofNames,
  reachesHub,
  touches,
} from "./lib/proofDeps.mts";

const proof = makeProof("proof-selection proof");
console.log("proof-selection proof\n");

const tracked = execFileSync("git", ["ls-files"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);
const names = proofNames();
const reaching = (path: string) =>
  names.filter((name) => touches(name, [path]));

try {
  await proof.check("every app import in a proof's graph names a file", () => {
    const unresolved = names.flatMap((name) => proofDeps(name).unresolved);
    assert.deepEqual(unresolved, []);
  });

  await proof.check("an import clause with comments in it is read", () => {
    const source = [
      "import {",
      "  foo, // the user's id",
      '  /* one; "two" */ bar,',
      '} from "@host/lib/x";',
      'import type { T } from "@shared/t";',
      'export { y } from "./y";',
    ].join("\n");
    assert.deepEqual(importedSpecifiers(source, false), ["@host/lib/x", "./y"]);
    assert.deepEqual(importedSpecifiers(source, true), [
      "@host/lib/x",
      "@shared/t",
      "./y",
    ]);
  });

  await proof.check("every covers glob matches a tracked file", () => {
    const stale = names.flatMap((name) =>
      proofDeps(name)
        .covers.filter((glob) => !tracked.some((p) => matchesGlob(p, glob)))
        .map((glob) => `${name}: ${glob}`),
    );
    assert.deepEqual(stale, []);
  });

  await proof.check(
    "files reached only through the loader, deep imports or covers lines pick their proofs",
    () => {
      // A path, the proofs it picks, and the proofs it must not.
      const expect: [string, string[], string[]?][] = [
        ["app/test/lib/tsAliasLoader.mts", names],
        ["app/host/lib/git/core.ts", ["clone"]],
        ["app/shared/account/service.ts", ["hub-link", "web-hub"]],
        ["app/shared/hub/directPlane.ts", ["port-forward"]],
        ["app/shared/packaging/updateFeed.mts", ["changelog", "app-updates"]],
        ["app/test/lib/checkKit.mts", ["liveness", "keychain"]],
        // checkKit imports cliDelegate.ts for its types alone.
        ["app/host/ipc/cliDelegate.ts", [], ["keychain"]],
        // Not imports: a build of sm, a fixture read off disk, a scan.
        ["cli/main.go", ["identity", "cli-reads", "fresh-install"]],
        ["file-sync/engine.go", ["mirror"]],
        ["app/shared/fixtures/repo-identity-urls.json", ["identity"]],
        ["app/renderer/App.tsx", ["host-boundary"]],
        ["app/pnpm-lock.yaml", ["theme-contract", "dmg-art"]],
      ];
      for (const [path, picks, skips = []] of expect) {
        const got = reaching(path);
        for (const name of picks) {
          assert.ok(got.includes(name), `${path} picks ${name}`);
        }
        for (const name of skips) {
          assert.ok(!got.includes(name), `${path} skips ${name}`);
        }
      }
    },
  );

  await proof.check("the hub's check runs for the app files it imports", () => {
    for (const path of [
      "hub/src/worker.ts",
      "app/shared/hub/protocol.ts",
      // Through protocol.ts and what it imports.
      "app/shared/ipc/socket/proof.ts",
      "app/shared/account/platform.ts",
    ]) {
      assert.ok(reachesHub([path]), path);
    }
    assert.ok(!reachesHub(["app/renderer/App.tsx"]));
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
