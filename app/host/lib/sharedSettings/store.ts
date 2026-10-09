// This device's copy of the shared settings
// (packages/contracts/src/schemas/sharedSettings.ts), kept in the
// store. The app is its one writer (the terminal never reads it), so
// the copy lives in memory, read from the store once at launch, and
// every change is written back behind it in the order it was made.
//
// The rule a copy keeps (store and announce only what changed) is
// shared/sharedSettings.ts's createSharedSettingsCopy. This file is its
// storage.
import * as SharedSettings from "@shigomori/engine/SharedSettings";
import * as Effect from "effect/Effect";
import { errorMessageOf } from "@shigomori/contracts/errors";
import {
  createSharedSettingsCopy,
  EMPTY_SHARED_SETTINGS,
} from "@shared/sharedSettings";
import type { SharedSettingsDoc } from "@shigomori/contracts/schemas/sharedSettings";
import { getDeviceId } from "../config/deviceId";
import * as Engine from "../engine";
import { log } from "@shared/log";

let held: SharedSettingsDoc = EMPTY_SHARED_SETTINGS;
let written: Promise<unknown> = Promise.resolve();

// At launch, once the store is open.
export async function loadSharedSettings(): Promise<void> {
  held = await Engine.run(
    Effect.gen(function* () {
      return yield* (yield* SharedSettings.SharedSettings).read;
    }),
  );
}

// Settles once every change made so far is in the store.
export function sharedSettingsStored(): Promise<unknown> {
  return written;
}

function persist(doc: SharedSettingsDoc): void {
  written = written
    .then(() =>
      Engine.run(
        Effect.gen(function* () {
          yield* (yield* SharedSettings.SharedSettings).update(() => doc);
        }),
      ),
    )
    .catch((error: unknown) => {
      log.warn(
        `[sharedSettings] the copy wasn't stored: ${errorMessageOf(error)}`,
      );
    });
}

type ChangeListener = (doc: SharedSettingsDoc) => void;
const changeListeners = new Set<ChangeListener>();

// Followers of "this copy moved", fired after the write landed and
// never for a merge that learned nothing. The Electron layer fans it
// out to every window and peer (main/electron/hostImpls.ts).
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
    deviceId: getDeviceId,
    // The write has landed, so a listener's failure must not read as
    // the write's (onGlobalConfigChange's rule).
    announce: (doc) => {
      for (const listener of changeListeners) {
        try {
          listener(doc);
        } catch (error) {
          log.warn(
            `[sharedSettings] change listener failed: ${errorMessageOf(error)}`,
          );
        }
      }
    },
  },
);
