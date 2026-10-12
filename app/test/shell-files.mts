// Proof for the shell's own files: the ones it writes on the way out,
// synchronously (main/core/files/exitFiles.ts), the ones it writes while
// it runs, on FileSystem (main/core/files/jsonFile.ts), and the
// updater's bridge to `sm update` over them
// (main/electron/updaterBridge.ts):
//   - each helper writes a file whole, reads it back checked against
//     its schema, and reads an absent one as null; a broken one fails
//     to read, and the exit path's mode is kept,
//   - the bridge publishes the updater's state, consumes a request
//     waiting at its start and one the CLI writes later, drops a stale
//     one, and leaves no claimed file behind,
//   - a fresh request written while the bridge's first consume is still
//     reading a stale one is handled, not deleted with the stale one.
//
// Run: pnpm test shell-files.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterAll, afterEach, beforeEach, it, vi } from "vitest";
import { dataDir, initDataDirAt } from "@shared/paths";
import {
  atomicWriteJsonSync,
  readJsonOrNullSync,
} from "../main/core/files/exitFiles.ts";
import { readJson, writeJson } from "../main/core/files/jsonFile.ts";
import { waitFor } from "./lib/checkKit.mts";

vi.mock("electron", () => ({ app: { getVersion: () => "9.9.9" } }));
const { publishUpdaterState, updaterBridge } =
  await import("../main/electron/updaterBridge");

const Doc = Schema.Struct({ hidden: Schema.Boolean });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shell-files-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The bridge's data dir, once per process like the app's.
initDataDirAt(mkdtempSync(join(tmpdir(), "shell-files-data-")));
afterAll(() => rmSync(dataDir(), { recursive: true, force: true }));
// `sm update` asking, at the time given.
const request = (requestedAt: number) =>
  writeFileSync(
    join(dataDir(), "updater-request.json"),
    JSON.stringify({ action: "install", requestedAt }),
  );

const onPlatform = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices>,
) => Effect.runPromise(Effect.provide(effect, NodeServices.layer));

it("the exit path's files: whole, checked, absent as null, and the owner's alone when asked", () => {
  const file = join(dir, "nested", "restartVisibility.json");
  assert.equal(readJsonOrNullSync(file, Doc), null);
  atomicWriteJsonSync(file, { hidden: true }, { mode: 0o600 });
  assert.deepEqual(readJsonOrNullSync(file, Doc), { hidden: true });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(dir, "nested")), [
    "restartVisibility.json",
  ]);
  writeFileSync(file, "{broken");
  assert.throws(() => readJsonOrNullSync(file, Doc), /Failed to read/);
});

it("the running files: whole on FileSystem, checked, absent as null", async () => {
  const file = join(dir, "nested", "clientConfig.json");
  assert.equal(await onPlatform(readJson(file, Doc)), null);
  await onPlatform(writeJson(file, { hidden: false }));
  assert.deepEqual(await onPlatform(readJson(file, Doc)), { hidden: false });
  assert.deepEqual(readdirSync(join(dir, "nested")), ["clientConfig.json"]);
  writeFileSync(file, "{broken");
  const exit = await Effect.runPromiseExit(
    readJson(file, Doc).pipe(Effect.provide(NodeServices.layer)),
  );
  assert.ok(Exit.isFailure(exit));
});

it("the updater's bridge: publishes the state, consumes a waiting request and a later one, drops a stale one", async () => {
  await onPlatform(publishUpdaterState({ kind: "idle" }));
  assert.deepEqual(
    JSON.parse(readFileSync(join(dataDir(), "updater.json"), "utf8")),
    { pid: process.pid, appVersion: "9.9.9", state: { kind: "idle" } },
  );
  const asked: string[] = [];
  // Waiting at the start, but stale.
  request(Date.now() - 10 * 60_000);
  const scope = Scope.makeUnsafe();
  try {
    await onPlatform(
      updaterBridge((action) => asked.push(action)).pipe(Scope.provide(scope)),
    );
    assert.deepEqual(asked, [], "a stale request was acted on");
    assert.equal(existsSync(join(dataDir(), "updater-request.json")), false);
    // The CLI asks while the app runs.
    request(Date.now());
    await waitFor(() => asked.length === 1, "the request to be consumed");
    assert.deepEqual(asked, ["install"]);
    await waitFor(
      () =>
        !existsSync(join(dataDir(), "updater-request.json")) &&
        !existsSync(join(dataDir(), "updater-request.json.consuming")),
      "the claimed request to go",
    );
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

it("the updater's bridge: listens before it returns, however slow its watch is to start", async () => {
  const asked: string[] = [];
  const scope = Scope.makeUnsafe();
  try {
    await onPlatform(
      Effect.gen(function* () {
        const real = yield* FileSystem.FileSystem;
        // The platform's watch, slow to start as on a busy disk (it
        // stats the folder on a fiber of its own first): a bridge that
        // listened through it would return deaf.
        const fs: FileSystem.FileSystem = {
          ...real,
          watch: (path, options) =>
            Stream.unwrap(
              Effect.sleep("200 millis").pipe(
                Effect.as(real.watch(path, options)),
              ),
            ),
        };
        yield* updaterBridge((action) => asked.push(action)).pipe(
          Scope.provide(scope),
          Effect.provideService(FileSystem.FileSystem, fs),
        );
      }),
    );
    // The CLI asks the moment the bridge is up.
    request(Date.now());
    await waitFor(() => asked.length === 1, "the request to be consumed");
    assert.deepEqual(asked, ["install"]);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

it("the updater's bridge: a request written while the first consume reads a stale one is still handled", async () => {
  const requestPath = join(dataDir(), "updater-request.json");
  const claimed = `${requestPath}.consuming`;
  request(Date.now() - 10 * 60_000);
  const asked: string[] = [];
  const scope = Scope.makeUnsafe();
  try {
    await onPlatform(
      Effect.gen(function* () {
        const real = yield* FileSystem.FileSystem;
        const firstRemoved = yield* Deferred.make<void>();
        let reads = 0;
        // The real file system, with the first consume's read writing a
        // fresh request as it reads the stale one, which the watch hears
        // while that consume still holds its claim. Renames are
        // synchronous so a consume that claims doesn't wait on the disk,
        // and a later read waits for the first consume's cleanup, the
        // order that loses the fresh request when the two overlap.
        const fs: FileSystem.FileSystem = {
          ...real,
          rename: (from, to) =>
            Effect.suspend(() => {
              try {
                renameSync(from, to);
                return Effect.void;
              } catch {
                return real.rename(from, to);
              }
            }),
          readFileString: (path, encoding) =>
            path !== claimed
              ? real.readFileString(path, encoding)
              : ++reads === 1
                ? Effect.sync(() => {
                    const stale = readFileSync(path, "utf8");
                    request(Date.now());
                    return stale;
                  })
                : Deferred.await(firstRemoved).pipe(
                    Effect.andThen(real.readFileString(path, encoding)),
                  ),
          remove: (path, options) =>
            real
              .remove(path, options)
              .pipe(
                Effect.ensuring(
                  path === claimed
                    ? Deferred.succeed(firstRemoved, undefined)
                    : Effect.void,
                ),
              ),
        };
        yield* updaterBridge((action) => asked.push(action)).pipe(
          Scope.provide(scope),
          Effect.provideService(FileSystem.FileSystem, fs),
        );
      }),
    );
    await waitFor(() => asked.length === 1, "the fresh request to be consumed");
    assert.deepEqual(asked, ["install"]);
    assert.equal(existsSync(requestPath), false);
    assert.equal(existsSync(claimed), false);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});
