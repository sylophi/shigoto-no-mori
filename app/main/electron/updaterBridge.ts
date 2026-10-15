// The updater's on-disk bridge to the CLI. `sm update` has no IPC
// channel into the app's updater, so the two talk through the data
// dir: the app publishes its updater state to
// updater.json ({ pid, appVersion, state }) on boot and on every state
// change, and consumes updater-request.json ({ action, requestedAt })
// written by the CLI. The request is looked for every second from boot
// on, not watched for: the data dir holds the worktrees, and under
// their churn macOS's FSEvents drops events, which Node's fs.watch
// passes over in silence. A failed publish degrades `sm update`, never
// the updater itself.
import path from "node:path";
import { app } from "electron";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import type { UpdaterState, UpdaterStatus } from "@shigomori/contracts/schemas";
import { UpdateRequestSchema } from "@shigomori/contracts/schemas";
import { updaterFiles } from "@shigomori/engine/Updater";
import { dataDir } from "@shared/paths";
import { readJson, writeJson } from "../core/files/jsonFile";

const REQUEST_STALE_MS = 2 * 60_000;
const REQUEST_POLL_MS = 1000;

const files = () => updaterFiles(path, dataDir());

// One publish at a time: setState can fire twice in one tick (a
// synchronous throw right after entering "checking"), and two racing
// writes could land out of order, freezing the file on the older state.
const publishing = Semaphore.makeUnsafe(1);

export const publishUpdaterState = (state: UpdaterState) => {
  // Captured now, not when the write gets its turn, so each writes the
  // state its setState call carried.
  const status: UpdaterStatus = {
    pid: process.pid,
    appVersion: app.getVersion(),
    state,
  };
  // The CLI treats a missing or stale file as "app not reachable".
  return publishing.withPermit(
    Effect.ignore(writeJson(files().status, status)),
  );
};

// The poll, so the data-folder move can let go of the data dir.
let polling: FiberHandle.FiberHandle | null = null;

// Consumes the request, for the length of the scope (the updater's
// layer). A request is claimed by renaming it aside before it is read,
// so a fresh one landing mid-read keeps its own file instead of being
// deleted unread, and the claimed file always goes, since an
// unparseable leftover must not shadow the next request. A claim that
// fails for any reason but there being no request is `failed`'s, every
// poll until it clears.
export const updaterBridge = ({
  install,
  failed,
}: {
  readonly install: () => void;
  readonly failed: (error: unknown) => void;
}): Effect.Effect<void, never, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const consumingPath = () => files().request + ".consuming";
    const consume = Effect.gen(function* () {
      const claimed = yield* fs.rename(files().request, consumingPath()).pipe(
        Effect.as(true),
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed(false),
        ),
      );
      if (!claimed) return;
      const request = yield* readJson(
        consumingPath(),
        UpdateRequestSchema,
      ).pipe(Effect.orElseSucceed(() => null));
      yield* Effect.ignore(fs.remove(consumingPath(), { force: true }));
      if (request === null) return;
      const now = yield* Clock.currentTimeMillis;
      // A dropped request: the CLI times out and says so.
      if (now - request.requestedAt > REQUEST_STALE_MS) return;
      // The only action there is (UpdateRequestSchema).
      install();
    }).pipe(Effect.catch((error) => Effect.sync(() => failed(error))));
    polling = yield* FiberHandle.make();
    yield* FiberHandle.run(
      polling,
      consume.pipe(Effect.repeat(Schedule.spaced(REQUEST_POLL_MS))),
    );
  });

// Released before the data-folder move renames the data dir. The
// post-move relaunch starts a fresh bridge.
export function stopUpdaterBridge(): void {
  if (polling !== null) Effect.runFork(FiberHandle.clear(polling));
  polling = null;
}
