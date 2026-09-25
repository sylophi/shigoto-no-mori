// The stable per-browser hub device identity.
// The desktop's deviceId is a UUID naming a shigomori root, minted once
// and persisted in registry.json (host/lib/config/deviceId.ts). The web
// client has no root, so its analogue is a UUID naming this browser
// profile, minted on first use and persisted in localStorage: the same
// browser is the same hub device across sessions, and clearing site
// data re-enrolls it as a brand new device, exactly like a registry
// reset does on desktop.
import { DeviceIdSchema } from "@shared/hub/protocol";
import { readKey, writeKey, type KeyValueStorage } from "../lib/kvStorage";

const DEVICE_ID_KEY = "sm.web.deviceId";

// The same well-formed-UUID acceptance rule the desktop applies: the
// stored value is user-visible storage and the id flows into query keys
// and hub routing, so anything mangled is replaced rather than
// trusted. crypto.randomUUID output always passes both this shape and
// the wire's DeviceIdSchema bound.
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidDeviceId(value: string | null): value is string {
  return (
    value !== null &&
    UUID_SHAPE.test(value) &&
    DeviceIdSchema.safeParse(value).success
  );
}

// Reads the persisted id, minting and persisting one when it is missing
// or malformed. Idempotent: repeat calls against the same storage return
// the same id. crypto.randomUUID is a WebCrypto global in browsers and
// node 22 alike, so the headless check can drive this too.
export function getWebDeviceId(storage: KeyValueStorage): string {
  const found = readKey(storage, DEVICE_ID_KEY);
  if (isValidDeviceId(found)) return found;
  const minted = crypto.randomUUID();
  writeKey(storage, DEVICE_ID_KEY, minted);
  return minted;
}
