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
//   - a fresh request written while the bridge is still reading a stale
//     one is handled, not deleted with the stale one,
//   - a claim that fails is reported and the polling goes on, and the
//     polling ends with the bridge's scope.
//
// Run: pnpm test shell-files.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
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

// The bridge on its own scope, its requests and failures noted.
const bridge = (fs?: FileSystem.FileSystem, clock?: TestClock.TestClock) => {
  const asked: string[] = [];
  const failures: unknown[] = [];
  const scope = Scope.makeUnsafe();
  const started = onPlatform(
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem;
      yield* updaterBridge({
        install: () => asked.push("install"),
        failed: (error) => failures.push(error),
      }).pipe(
        Scope.provide(scope),
        Effect.provideService(FileSystem.FileSystem, fs ?? real),
        clock ? Effect.provideService(Clock.Clock, clock) : (self) => self,
      );
    }),
  );
  return {
    asked,
    failures,
    started,
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

const requestPath = () => join(dataDir(), "updater-request.json");
const claimedPath = () => `${requestPath()}.consuming`;

it("the updater's bridge: publishes the state, consumes a waiting request and a later one, drops a stale one", async () => {
  await onPlatform(publishUpdaterState({ kind: "idle" }));
  assert.deepEqual(
    JSON.parse(readFileSync(join(dataDir(), "updater.json"), "utf8")),
    { pid: process.pid, appVersion: "9.9.9", state: { kind: "idle" } },
  );
  // Waiting at the start, but stale.
  request(Date.now() - 10 * 60_000);
  const { asked, failures, started, stop } = bridge();
  try {
    await started;
    await waitFor(() => !existsSync(requestPath()), "the stale request to go");
    assert.deepEqual(asked, [], "a stale request was acted on");
    // The CLI asks while the app runs.
    request(Date.now());
    await waitFor(() => asked.length === 1, "the request to be consumed");
    await waitFor(
      () => !existsSync(requestPath()) && !existsSync(claimedPath()),
      "the claimed request to go",
    );
    assert.deepEqual(failures, []);
  } finally {
    await stop();
  }
});

it("the updater's bridge: a request written while a stale one is read is still handled", async () => {
  request(Date.now() - 10 * 60_000);
  let reads = 0;
  const { asked, started, stop } = bridge(
    await onPlatform(
      Effect.map(FileSystem.FileSystem, (real) => ({
        ...real,
        // The CLI writes a fresh request while the claimed stale one is
        // read, so it must survive the stale one's cleanup.
        readFileString: (path, encoding) =>
          path === claimedPath() && ++reads === 1
            ? real
                .readFileString(path, encoding)
                .pipe(Effect.tap(() => Effect.sync(() => request(Date.now()))))
            : real.readFileString(path, encoding),
      })),
    ),
  );
  try {
    await started;
    await waitFor(() => asked.length === 1, "the fresh request to be consumed");
    assert.equal(existsSync(requestPath()), false);
    assert.equal(existsSync(claimedPath()), false);
  } finally {
    await stop();
  }
});

it("the updater's bridge: a claim that fails is reported, and the next poll still consumes", async () => {
  request(Date.now());
  let renames = 0;
  const { asked, failures, started, stop } = bridge(
    await onPlatform(
      Effect.map(FileSystem.FileSystem, (real) => ({
        ...real,
        rename: (from, to) =>
          ++renames === 1
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: from,
                }),
              )
            : real.rename(from, to),
      })),
    ),
  );
  try {
    await started;
    await waitFor(() => asked.length === 1, "the request to be consumed");
    assert.equal(failures.length, 1);
    assert.ok(PlatformError.isPlatformError(failures[0]));
  } finally {
    await stop();
  }
});

it("the updater's bridge: stops looking with its scope", async () => {
  // Its looks counted on a clock the proof moves, so nothing here waits
  // on the runner's speed.
  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
  let looks = 0;
  let settled = 0;
  const { asked, started, stop } = bridge(
    await onPlatform(
      Effect.map(FileSystem.FileSystem, (real) => ({
        ...real,
        rename: (from, to) => {
          looks++;
          return real
            .rename(from, to)
            .pipe(Effect.ensuring(Effect.sync(() => settled++)));
        },
      })),
    ),
    clock,
  );
  await started;
  // A second ahead each time, as the next look's sleep may not have
  // begun yet.
  await waitFor(async () => {
    await Effect.runPromise(clock.adjust("1 second"));
    return settled >= 2 && settled === looks;
  }, "a look at the start and the clock's");
  // With no look under way, as a rename still on the thread pool can
  // claim a request written after the stop.
  const before = looks;
  await stop();
  request(Date.now());
  await Effect.runPromise(clock.adjust("1 minute"));
  assert.equal(looks, before);
  assert.deepEqual(asked, []);
  assert.equal(existsSync(requestPath()), true);
  rmSync(requestPath());
});
