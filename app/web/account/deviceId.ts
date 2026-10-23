// The stable per-browser hub device identity.
// The desktop's deviceId is a UUID naming a shigomori root, minted once
// and persisted in its store (the engine's Registry). The web
// client has no root, so its analogue is a UUID naming this browser
// profile, minted on first use and persisted in localStorage: the same
// browser is the same hub device across sessions, and clearing site
// data re-enrolls it as a brand new device, exactly like a registry
// reset does on desktop.
import { isMintedDeviceId } from "@shigomori/contracts/hubProtocol";
import { readKey, writeKey, type KeyValueStorage } from "../lib/kvStorage";

const DEVICE_ID_KEY = "sm.web.deviceId";

// The stored value is user-visible storage and the id flows into query
// keys and hub routing, so anything mangled is replaced rather than
// trusted, as the desktop does.
function isValidDeviceId(value: string | null): value is string {
  return value !== null && isMintedDeviceId(value);
}

// The persisted id, or null when it is missing or malformed.
export function readWebDeviceId(storage: KeyValueStorage): string | null {
  const found = readKey(storage, DEVICE_ID_KEY);
  return isValidDeviceId(found) ? found : null;
}

// Reads the persisted id, minting and persisting one when it is missing
// or malformed. Idempotent: repeat calls against the same storage return
// the same id.
export function getWebDeviceId(storage: KeyValueStorage): string {
  const found = readWebDeviceId(storage);
  if (found !== null) return found;
  const minted = crypto.randomUUID();
  writeKey(storage, DEVICE_ID_KEY, minted);
  return minted;
}

// Holds storage to the id this tab runs on, before it enrolls under it:
// one gone (the site's data cleared under an open tab) is written back,
// and one another tab minted since refuses the enrollment. A write that
// storage refuses fails it too, where a mint's would only cost the id.
export function keepWebDeviceId(storage: KeyValueStorage, id: string): void {
  const stored = readWebDeviceId(storage);
  if (stored === null) {
    storage.setItem(DEVICE_ID_KEY, id);
  } else if (stored !== id) {
    throw new Error(
      "Another tab of this browser changed its device. Reload this tab, then sign in.",
    );
  }
}
