// The updater's on-disk bridge to the CLI. `sm update` has no IPC
// channel into the app's updater, so the two talk through the data
// dir: the app publishes its updater state to
// updater.json ({ pid, appVersion, state }) on boot and on every state
// change, and consumes updater-request.json ({ action, requestedAt })
// written by the CLI. Requests are picked up at boot (a request can
// land in the gap around a restart) and via a watch of the data dir
// afterwards. Everything here is best-effort: a failed write or a
// malformed request degrades `sm update`, never the updater itself.
import { join } from "node:path";
import { app } from "electron";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type {
  UpdateRequest,
  UpdaterState,
  UpdaterStatus,
} from "@shigomori/contracts/schemas";
import { UpdateRequestSchema } from "@shigomori/contracts/schemas";
import { dataDir } from "@host/lib/util/paths";
import { readJson, writeJson } from "../core/files/jsonFile";

const REQUEST_STALE_MS = 2 * 60_000;
const REQUEST_FILE = "updater-request.json";

const updaterStatePath = () => join(dataDir(), "updater.json");
const updateRequestPath = () => join(dataDir(), REQUEST_FILE);

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
    Effect.ignore(writeJson(updaterStatePath(), status)),
  );
};

// The watch, so the data-folder move can let go of the data dir.
let watching: FiberHandle.FiberHandle | null = null;

// Consumes the request at boot, then each time the watch sees it
// written, for the length of the scope (the updater's layer). The
// watch's events burst (the CLI's temp and rename, this side's own
// cleanup echoing back), so a request is claimed by renaming it aside
// before it is read: a fresh one landing mid-read keeps its own file
// and its own event instead of being deleted unread, and the claimed
// file always goes, since unparseable leftovers must not shadow the
// next request. The events are handled one at a time.
export const updaterBridge = (
  handle: (action: UpdateRequest["action"]) => void,
): Effect.Effect<void, never, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const consumingPath = () => updateRequestPath() + ".consuming";
    // The boot's consume and the watch's share one claimed file, so they
    // take turns.
    const turns = yield* Semaphore.make(1);
    const consume = Effect.gen(function* () {
      yield* fs.rename(updateRequestPath(), consumingPath());
      const request = yield* readJson(
        consumingPath(),
        UpdateRequestSchema,
      ).pipe(Effect.orElseSucceed(() => null));
      yield* Effect.ignore(fs.remove(consumingPath(), { force: true }));
      if (request === null) return;
      const now = yield* Clock.currentTimeMillis;
      if (now - request.requestedAt > REQUEST_STALE_MS) return;
      handle(request.action);
    }).pipe(
      // Nothing to consume, or a dropped request: the CLI times out and
      // says so.
      Effect.ignore,
      turns.withPermits(1),
    );
    // A data dir that is missing or goes (a nuke) ends the watch; the
    // next launch watches afresh. Watched before the first consume, so
    // a request written meanwhile is either consumed or heard.
    watching = yield* FiberHandle.make();
    yield* FiberHandle.run(
      watching,
      fs.watch(dataDir()).pipe(
        Stream.filter((event) => event.path === REQUEST_FILE),
        Stream.runForEach(() => consume),
        Effect.ignore,
      ),
    );
    yield* consume;
  });

// Released before the data-folder move renames the data dir. The
// post-move relaunch starts a fresh bridge.
export function stopUpdaterBridge(): void {
  if (watching !== null) Effect.runFork(FiberHandle.clear(watching));
  watching = null;
}
