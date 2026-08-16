// The updater's on-disk bridge to the CLI. `sm update` has no IPC
// channel into the app, so the two talk through the state root like
// every other app<->CLI feature: the app publishes its updater state to
// updater.json ({ pid, appVersion, state }) on boot and on every state
// change, and consumes updater-request.json ({ action, requestedAt })
// written by the CLI -- picked up at boot (a request can land in the
// gap around a restart) and via an fs watch afterwards. Everything
// here is best-effort: a failed write or a malformed request degrades
// `sm update`, never the updater itself.
import { watch } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
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
} from "../lib/util/jsonFile";
import { shigomoriRoot } from "../lib/util/paths";

const REQUEST_STALE_MS = 2 * 60_000;

const updaterStatePath = () => join(shigomoriRoot(), "updater.json");
const updateRequestPath = () => join(shigomoriRoot(), "updater-request.json");

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
      // selfWrite: false -- this is control-plane plumbing the state
      // watcher ignores, not user state (see atomicWriteJson).
      await atomicWriteJson(updaterStatePath(), status, { selfWrite: false });
    } catch {
      // The CLI treats a missing/stale file as "app not reachable".
    }
  });
  return publishChain;
}

export function startUpdaterBridge(
  handle: (action: UpdateRequest["action"]) => void,
): void {
  // Watch events burst (the atomic write's tmp+rename, our own cleanup
  // echoing back), so consumes are single-flight -- but an event that
  // lands mid-consume is deferred via `rerun`, never dropped: it may be
  // the only event a just-written request ever gets.
  let consuming = false;
  let rerun = false;
  const consumingPath = () => updateRequestPath() + ".consuming";
  const consume = async () => {
    if (consuming) {
      rerun = true;
      return;
    }
    consuming = true;
    try {
      /* oxlint-disable no-await-in-loop -- the loop is a retry latch:
         each pass must fully finish before rerunning for a deferred
         event, so there is nothing to parallelize. */
      do {
        rerun = false;
        // Claim atomically before reading: a fresh request landing
        // mid-consume keeps its own file (and its own watch event,
        // deferred through `rerun`) instead of being deleted unread by
        // this pass's cleanup. The claimed file is always removed --
        // unparseable leftovers must not shadow the next request.
        try {
          await rename(updateRequestPath(), consumingPath());
        } catch {
          continue; // nothing to consume
        }
        const request = await readJsonOrNull(
          consumingPath(),
          UpdateRequestSchema,
        ).catch(() => null);
        await unlinkIfExists(consumingPath());
        if (request === null) continue;
        if (Date.now() - request.requestedAt > REQUEST_STALE_MS) continue;
        handle(request.action);
      } while (rerun);
      /* oxlint-enable no-await-in-loop */
    } catch {
      // Dropped request. The CLI times out and says so.
    } finally {
      consuming = false;
    }
  };
  void consume();
  try {
    bridgeWatcher = watch(
      shigomoriRoot(),
      { persistent: false },
      (_eventType, file) => {
        if (file === "updater-request.json") void consume();
      },
    );
    bridgeWatcher.on("error", () => {
      // Root vanished (nuke). The next launch starts a fresh watch.
    });
  } catch {
    // Root missing entirely. Boot creates it, the next launch watches.
  }
}

let bridgeWatcher: ReturnType<typeof watch> | null = null;

// Same contract as stopStateWatcher: released before the data-folder
// move renames the root (Windows watch handles can block the rename).
// The post-move relaunch starts a fresh bridge.
export function stopUpdaterBridge(): void {
  bridgeWatcher?.close();
  bridgeWatcher = null;
}
