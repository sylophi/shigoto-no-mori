// This device's copy of the shared settings
// (packages/contracts/src/schemas/sharedSettings.ts), kept in the
// store. The app is its one writer (the terminal never reads it), so
// the copy lives in memory, read from the store once at launch, and
// every change is written back behind it in the order it was made.
//
// The rule a copy keeps (store and announce only what changed) is
// contracts' sharedSettings.ts's createSharedSettingsCopy. This file is its
// storage.
import { errorWordsOf } from "@host/lib/errorWords";
import {
  createSharedSettingsCopy,
  EMPTY_SHARED_SETTINGS,
} from "@shigomori/contracts/sharedSettings";
import type { SharedSettingsDoc } from "@shigomori/contracts/schemas/sharedSettings";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as DeviceId from "../config/DeviceId";
import * as Ops from "../engineOps";
import { log } from "@shared/log";
import { layerLatch } from "@shared/layerLatch";

let held: SharedSettingsDoc = EMPTY_SHARED_SETTINGS;
// The device a pick here is stamped with, read with the copy.
let deviceId = "";
// The changes not stored yet, in the order they were made, which the
// layer's writer stores one at a time.
const unstored: SharedSettingsDoc[] = [];
// A second, doubling, then every half minute.
const WRITE_RETRY = Schedule.min([
  Schedule.exponential("1 second", 2),
  Schedule.spaced("30 seconds"),
]);

const waiting = Latch.makeUnsafe(false);
const allStored = Latch.makeUnsafe(true);

function persist(doc: SharedSettingsDoc): void {
  unstored.push(doc);
  allStored.closeUnsafe();
  waiting.openUnsafe();
}

const writer = Effect.forever(
  Effect.gen(function* () {
    yield* waiting.await;
    const doc = unstored.shift();
    if (doc === undefined) {
      waiting.closeUnsafe();
      allStored.openUnsafe();
      return;
    }
    // A write that fails (the store busy, the disk full) is tried again
    // until it lands, the changes after it waiting their turn: the loop
    // ending on one would leave every later change announced and never
    // stored.
    yield* Ops.storeSharedSettings(doc).pipe(
      Effect.sandbox,
      Effect.tapError((cause) =>
        Effect.logWarning(
          "[settings] couldn't store the shared settings, trying again",
          cause,
        ),
      ),
      Effect.retry(WRITE_RETRY),
    );
  }),
);

// Read from the store once at launch, then written behind every change
// until the app quits. A reader before then waits for it.
const loaded = layerLatch<void>("The shared settings");
export const layer = Layer.effectDiscard(
  loaded.provide(
    Effect.gen(function* () {
      deviceId = yield* DeviceId.current;
      held = yield* Ops.readSharedSettings;
      yield* Effect.forkScoped(writer);
    }),
  ),
);
export const sharedSettingsLoaded = loaded.get;

// Once every change made so far is in the store.
export const sharedSettingsStored = allStored.await;

type ChangeListener = (doc: SharedSettingsDoc) => void;
const changeListeners = new Set<ChangeListener>();

// Followers of "this copy moved", fired after the write landed and
// never for a merge that learned nothing. The host's root fans it
// out to every window and peer (process/handlers.ts).
export function onSharedSettingsChange(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export const sharedSettingsCopy = createSharedSettingsCopy(
  {
    read: () => held,
    transact: (next) => {
      const changed = next(held);
      if (changed === undefined) return;
      held = changed;
      persist(changed);
    },
  },
  {
    deviceId: () => deviceId,
    // The write has landed, so a listener's failure must not read as
    // the write's.
    announce: (doc) => {
      for (const listener of changeListeners) {
        try {
          listener(doc);
        } catch (error) {
          log.warn(
            `[sharedSettings] change listener failed: ${errorWordsOf(error)}`,
          );
        }
      }
    },
  },
);
