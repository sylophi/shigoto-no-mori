// The updater's on-disk bridge to the CLI. `sm update` has no IPC
// channel into the app, so the two talk through the data dir like
// every other app<->CLI feature: the app publishes its updater state to
// updater.json ({ pid, appVersion, state }) on boot and on every state
// change, and consumes updater-request.json ({ action, requestedAt })
// written by the CLI. Requests are picked up at boot (a request can
// land in the gap around a restart) and via an fs watch afterwards.
// Everything here is best-effort: a failed write or a malformed
// request degrades `sm update`, never the updater itself.
import { type FSWatcher, watch } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { Effect, Exit, Queue, Scope } from "effect";
import type {
  UpdateRequest,
  UpdaterState,
  UpdaterStatus,
} from "@shared/schemas";
import { UpdateRequestSchema } from "@shared/schemas";
import {
  atomicWriteJson,
  readJsonOrNull,
  unlinkIfExists,
} from "@host/lib/util/jsonFile";
import { dataDir } from "@host/lib/util/paths";

const REQUEST_STALE_MS = 2 * 60_000;

const updaterStatePath = () => join(dataDir(), "updater.json");
const updateRequestPath = () => join(dataDir(), "updater-request.json");

// Publishes are serialized through a chain: setState can fire twice in
// one tick (a synchronous throw right after entering "checking"), and
// two racing tmp+rename writes could land out of order, freezing the
// file on the older state.
let publishChain: Promise<void> = Promise.resolve();

export function publishUpdaterState(state: UpdaterState): Promise<void> {
  // Captured now, not when the chain gets to it, so each link writes
  // the state its setState call carried.
  const status: UpdaterStatus = {
    pid: process.pid,
    appVersion: app.getVersion(),
    state,
  };
  publishChain = publishChain.then(async () => {
    try {
      // selfWrite: false because this is control-plane plumbing the
      // state watcher ignores, not user state (see atomicWriteJson).
      await atomicWriteJson(updaterStatePath(), status, { selfWrite: false });
    } catch {
      // The CLI treats a missing/stale file as "app not reachable".
    }
  });
  return publishChain;
}

// One consume pass: claim the request file, read it, drop it, act on
// it. Resolves either way; a failed pass is a dropped request, and the
// CLI times out and says so.
async function consumeOnce(
  handle: (action: UpdateRequest["action"]) => void,
): Promise<void> {
  // Everything inside the try, the path included: a throw out of here
  // (the data dir not set up yet) would end the drain fiber below with
  // nothing logging it, and every later request would go unread.
  try {
    const consumingPath = updateRequestPath() + ".consuming";
    // Claim atomically before reading: a fresh request landing
    // mid-consume keeps its own file (and its own watch event, queued
    // for the next pass) instead of being deleted unread by this pass's
    // cleanup. The claimed file is always removed, since unparseable
    // leftovers must not shadow the next request.
    try {
      await rename(updateRequestPath(), consumingPath);
    } catch {
      return; // nothing to consume
    }
    const request = await readJsonOrNull(
      consumingPath,
      UpdateRequestSchema,
    ).catch(() => null);
    await unlinkIfExists(consumingPath);
    if (request === null) return;
    if (Date.now() - request.requestedAt > REQUEST_STALE_MS) return;
    handle(request.action);
  } catch {
    // Dropped request. The CLI times out and says so.
  }
}

// The bridge while it runs: the watch, and the scope its consumer fiber
// is forked into.
let bridge: { watcher: FSWatcher | null; scope: Scope.Closeable } | null = null;

export function startUpdaterBridge(
  handle: (action: UpdateRequest["action"]) => void,
): void {
  if (bridge !== null) return;
  // Watch events burst (the atomic write's tmp+rename, our own cleanup
  // echoing back), so consumes are single-flight: every event is a
  // "look again" put on a sliding queue of one, drained by one fiber.
  // Events that land mid-pass collapse into the one queued behind it,
  // so a pass runs once more after the current one, never zero times
  // (it may be the only event a just-written request ever gets) and
  // never once per event.
  const wakes = Effect.runSync(Queue.sliding<void>(1));
  const scope = Scope.makeUnsafe();
  Effect.runSync(
    Queue.take(wakes).pipe(
      Effect.andThen(
        // Uninterruptible: a stop mid-pass lets it finish, so a claimed
        // request is never left behind as a .consuming file.
        Effect.uninterruptible(Effect.promise(() => consumeOnce(handle))),
      ),
      Effect.forever,
      Effect.forkIn(scope),
    ),
  );
  const wake = () => {
    Queue.offerUnsafe(wakes, undefined);
  };
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(dataDir(), { persistent: false }, (_eventType, file) => {
      if (file === "updater-request.json") wake();
    });
    watcher.on("error", () => {
      // Data dir vanished (nuke). The next launch starts a fresh watch.
    });
  } catch {
    // Data dir missing entirely. Boot creates it, the next launch watches.
  }
  bridge = { watcher, scope };
  // A request can land in the gap around a restart, before the watch.
  wake();
}

// Same contract as stopStateWatcher: released before the data-folder
// move renames the data dir. The post-move relaunch starts a fresh bridge.
export function stopUpdaterBridge(): void {
  const current = bridge;
  bridge = null;
  if (current === null) return;
  current.watcher?.close();
  Effect.runFork(Scope.close(current.scope, Exit.void));
}
