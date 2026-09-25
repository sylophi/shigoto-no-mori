// This device's copy of the shared settings
// (shared/schemas/sharedSettings.ts), one key in registry.json beside
// the rest of what the user has set up and cannot rebuild by using the
// app. The CLI never reads it and carries it through its own registry
// writes untouched, like the device id.
//
// The rule a copy keeps (store and announce only what changed) is
// shared/sharedSettings.ts's createSharedSettingsCopy. This file is its
// storage: every write goes through updateKey, so the copy a merge is
// computed from is read under the registry lock and two writers (this
// window's pick, a peer's push) can never overwrite each other's
// entries.
import { errorMessageOf } from "@shared/errors";
import {
  createSharedSettingsCopy,
  EMPTY_SHARED_SETTINGS,
} from "@shared/sharedSettings";
import {
  SharedSettingsDocSchema,
  type SharedSettingsDoc,
} from "@shared/schemas/sharedSettings";
import { getDeviceId } from "../config/deviceId";
import { registryStore, SHARED_SETTINGS_KEY } from "../config/store";

// registry.json is hand-editable, so the stored value is parsed rather
// than trusted. A mangled one reads as empty, and the next merge from
// any peer fills it back in.
function parse(stored: unknown): SharedSettingsDoc {
  const parsed = SharedSettingsDocSchema.safeParse(stored);
  return parsed.success ? parsed.data : EMPTY_SHARED_SETTINGS;
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
    // A hint read: an unreadable registry answers empty rather than
    // failing a peer's pull or this window's view. Nothing is written
    // from it, since a write reads again, strictly, under the lock.
    read: () =>
      parse(registryStore.readHint<unknown>(SHARED_SETTINGS_KEY, undefined)),
    transact: (next) =>
      registryStore.updateKey<unknown>(
        SHARED_SETTINGS_KEY,
        undefined,
        (stored) => next(parse(stored)),
      ),
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
          console.warn(
            `[sharedSettings] change listener failed: ${errorMessageOf(error)}`,
          );
        }
      }
    },
  },
);
