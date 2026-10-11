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
//     one, and leaves no claimed file behind.
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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { afterEach, beforeEach, it, vi } from "vitest";
import { initDataDirAt } from "@host/lib/util/paths";
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
  initDataDirAt(dir);
  const request = (requestedAt: number) =>
    writeFileSync(
      join(dir, "updater-request.json"),
      JSON.stringify({ action: "install", requestedAt }),
    );
  await onPlatform(publishUpdaterState({ kind: "idle" }));
  assert.deepEqual(
    JSON.parse(readFileSync(join(dir, "updater.json"), "utf8")),
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
    assert.equal(existsSync(join(dir, "updater-request.json")), false);
    // The CLI asks while the app runs.
    request(Date.now());
    await waitFor(() => asked.length === 1, "the request to be consumed");
    assert.deepEqual(asked, ["install"]);
    await waitFor(
      () =>
        !existsSync(join(dir, "updater-request.json")) &&
        !existsSync(join(dir, "updater-request.json.consuming")),
      "the claimed request to go",
    );
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});
