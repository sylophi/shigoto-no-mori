// The deviceId is a UUID naming this shigomori data dir, minted here on
// the data dir's first use and durable for its lifetime. That is why it
// lives in registry.json with the other setup the user can't rebuild,
// and why it is never derived from the machine.
import { randomUUID } from "node:crypto";
import { DEVICE_ID_KEY, registryStore } from "./store";

// registry.json is hand-editable, and the id flows into every
// host-scoped query key, so only a well-formed UUID is accepted: the
// store decodes the key against DeviceIdSchema and reads any other value
// (wrong type, mangled string) as absent, which is replaced under the
// lock. Self-healing is safe today because nothing else keys off an old
// id.

// The id is a boot-time constant of the data dir (like its path
// itself), so repeat reads never have to touch the file. "" means not
// read yet.
let cached = "";

export function getDeviceId(): string {
  if (cached) return cached;
  // Lock-free fast path: a valid id is write-once, so one found
  // without the registry lock is already final.
  const found = registryStore.readKey<string>(DEVICE_ID_KEY, "");
  if (found !== "") {
    cached = found;
    return cached;
  }
  // Mint inside updateKey, so the re-read happens under the registry
  // lock: two processes racing on a fresh data dir settle on one id
  // instead of the loser overwriting the winner's.
  registryStore.updateKey<string>(DEVICE_ID_KEY, "", (current) => {
    if (current !== "") {
      cached = current;
      return undefined;
    }
    cached = randomUUID();
    return cached;
  });
  return cached;
}
