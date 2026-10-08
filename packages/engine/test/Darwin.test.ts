// The Darwin service against the real helper, built from macfs/ once
// for the file, on throwaway trees.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { afterAll, beforeAll, it } from "vitest";
import * as Darwin from "../src/Darwin.ts";

let scratch = "";
let binary = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "engine-darwin-"));
  binary = join(scratch, "macfs");
  execFileSync("go", [
    "build",
    "-C",
    join(import.meta.dirname, "../../../macfs"),
    "-o",
    binary,
    ".",
  ]);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const collect = <A, E>(
  stream: (darwin: Darwin.Darwin["Service"]) => Stream.Stream<A, E>,
  helper = binary,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const darwin = yield* Darwin.Darwin;
      return yield* Stream.runCollect(stream(darwin));
    }).pipe(
      Effect.provide(
        Darwin.layer(helper).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

const byPath = <A extends { readonly path: string }>(entries: readonly A[]) =>
  new Map(entries.map((entry) => [entry.path, entry]));

function tree(): string {
  const root = mkdtempSync(join(scratch, "tree-"));
  mkdirSync(join(root, "a"));
  writeFileSync(join(root, "a/f.txt"), "x".repeat(1 << 16));
  const old = new Date("2020-01-02T03:04:05Z");
  utimesSync(join(root, "a/f.txt"), old, old);
  return root;
}

it("walks a tree for flags and clears them", async () => {
  const root = tree();
  execFileSync("chflags", ["hidden", join(root, "a/f.txt")]);
  const found = byPath(await collect((d) => d.flags({ root })));
  assert.deepEqual([...found.keys()].toSorted(), [".", "a", "a/f.txt"]);
  assert.deepEqual(found.get("a/f.txt"), { path: "a/f.txt", flags: 0x8000 });

  await collect((d) => d.flags({ root, paths: ["a/f.txt"], clear: true }));
  const after = await collect((d) => d.flags({ root, paths: ["a/f.txt"] }));
  assert.deepEqual(after, [{ path: "a/f.txt", flags: 0 }]);
});

it("lists and strips extended attributes", async () => {
  const root = tree();
  execFileSync("xattr", ["-w", "user.note", "n", join(root, "a/f.txt")]);
  const names = async () => {
    const [entry] = await collect((d) =>
      d.xattrs({ root, paths: ["a/f.txt"] }),
    );
    assert.ok(entry && !Darwin.isFailed(entry));
    return entry.names.filter((name) => name !== "com.apple.provenance");
  };
  assert.deepEqual(await names(), ["user.note"]);
  await collect((d) => d.xattrs({ root, strip: true }));
  assert.deepEqual(await names(), []);
});

it("clones keeping the mtime, and a clone frees nothing", async () => {
  const from = tree();
  const to = mkdtempSync(join(scratch, "to-"));
  const cloned = await collect((d) =>
    d.clone({ from, to, paths: ["a", "missing"] }),
  );
  const entries = byPath(cloned);
  assert.deepEqual(entries.get("a"), { path: "a" });
  const missing = entries.get("missing");
  assert.ok(missing && Darwin.isFailed(missing));
  assert.equal(missing.error.code, "ENOENT");
  assert.equal(
    statSync(join(to, "a/f.txt")).mtimeMs,
    statSync(join(from, "a/f.txt")).mtimeMs,
  );

  const sizes = await collect((d) =>
    d.privateSize({ root: to, paths: ["a/f.txt"] }),
  );
  assert.deepEqual(sizes, [{ path: "a/f.txt", bytes: 0 }]);
});

it("names the filesystem", async () => {
  const types = await collect((d) => d.fsType({ root: scratch }));
  assert.deepEqual(types, [{ path: ".", type: "apfs" }]);
});

it("fails the stream when the helper does", async () => {
  const failure = (helper: string) =>
    collect((d) => d.fsType({ root: scratch }), helper).then(
      () => assert.fail("expected a failure"),
      (error: unknown) => error,
    );
  // Not there to spawn, exits non-zero, and prints what isn't a line.
  const cases = [
    [join(scratch, "nope"), "spawn"],
    ["/usr/bin/false", "exit"],
    ["/bin/echo", "output"],
  ] as const;
  const errors = await Promise.all(cases.map(([helper]) => failure(helper)));
  errors.forEach((error, i) => {
    assert.ok(error instanceof Darwin.DarwinHelperError, String(error));
    assert.equal(error.reason, cases[i]?.[1]);
  });
});
