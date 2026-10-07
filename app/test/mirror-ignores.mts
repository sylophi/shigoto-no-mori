// Durable proof for the bring rule's engine patterns
// (shared/mirrorIgnores.ts): a picked path escapes glob syntax on the
// way in and reads back as itself, the brought pairs sit past the
// marker so an allowlist gitignore ending in `!/src` pairs cannot be
// mistaken for them, the caps hold (64 paths, and the rules squeezed
// to what fits beside them under 512), and a plain ignore list has no
// brought paths.
//
// Run: pnpm test mirror-ignores.
import assert from "node:assert/strict";
import {
  anchorIgnoredPath,
  BRING_PATHS_LIMIT,
  bringIgnores,
  bringRulesRoom,
  broughtPaths,
  MIRROR_IGNORES_LIMIT,
  unanchorIgnoredPath,
} from "@shared/mirrorIgnores";
import { it } from "vitest";

const RULES = ["node_modules/", "*.log", "dist/", "!/keep", "!/keep/**"];

const names = (count: number, prefix: string): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}`);

it("a picked path anchors, escapes glob syntax and unanchors", () => {
  const cases: [path: string, anchored: string][] = [
    ["node_modules", "/node_modules"],
    ["dist/", "/dist"],
    ["a/b//", "/a/b"],
    ["app/[id]", "/app/\\[id\\]"],
    ["what?.txt", "/what\\?.txt"],
    ["star*", "/star\\*"],
    ["{a,b}", "/\\{a,b\\}"],
    ["back\\slash", "/back\\\\slash"],
  ];
  for (const [path, anchored] of cases) {
    assert.equal(anchorIgnoredPath(path), anchored, path);
    assert.equal(
      unanchorIgnoredPath(anchored),
      path.replace(/\/+$/, ""),
      anchored,
    );
  }
});

it("the brought paths read back from the patterns", () => {
  const brought = [".env", "app/[id]", "build/"];
  const ignores = bringIgnores(RULES, brought);
  assert.deepEqual(ignores, [
    ...RULES,
    "/.git/shigomori-brought",
    "!/.env",
    "!/.env/**",
    "!/app/\\[id\\]",
    "!/app/\\[id\\]/**",
    "!/build",
    "!/build/**",
  ]);
  assert.deepEqual(broughtPaths(ignores), [".env", "app/[id]", "build"]);
});

it("an allowlist gitignore's own `!` pairs are not brought paths", () => {
  // RULES ends in `!/keep`, `!/keep/**`: the same shape as a pair.
  assert.deepEqual(broughtPaths(bringIgnores(RULES, [])), []);
  assert.deepEqual(broughtPaths(RULES), []);
  assert.deepEqual(broughtPaths([]), []);
});

it("the marker is found from the end, so rules cannot fake one", () => {
  const ignores = bringIgnores(
    ["/.git/shigomori-brought", "!/x", "!/x/**", "*.log"],
    ["y"],
  );
  assert.deepEqual(broughtPaths(ignores), ["y"]);
});

it("at most 64 paths are brought", () => {
  const many = names(80, "p");
  const ignores = bringIgnores([], many);
  assert.deepEqual(broughtPaths(ignores), many.slice(0, BRING_PATHS_LIMIT));
  assert.equal(ignores.length, 1 + 2 * BRING_PATHS_LIMIT);
});

it("the rules are squeezed to what fits beside the paths", () => {
  const rules = names(600, "rule");
  for (const count of [0, 1, 10, BRING_PATHS_LIMIT, 100]) {
    const brought = names(count, "p");
    const ignores = bringIgnores(rules, brought);
    // More rules than fit, so the list is full for any path count.
    assert.equal(ignores.length, MIRROR_IGNORES_LIMIT, `${count} paths`);
    const room = bringRulesRoom(count);
    assert.deepEqual(ignores.slice(0, room), rules.slice(0, room));
    assert.equal(ignores[room], "/.git/shigomori-brought");
    assert.deepEqual(
      broughtPaths(ignores),
      brought.slice(0, BRING_PATHS_LIMIT),
    );
  }
});
