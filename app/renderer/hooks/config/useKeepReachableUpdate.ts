// Immediate writer for the keepReachable opt-in.
// Unlike appearance, which stages in the settings form and persists on
// Save, this toggle takes effect at once: flipping it should register or
// clear the OS login item right away, which the main-side write handler
// does when the value changes. keepReachable is on by default
// (keepReachableOn in shared/schemas/config.ts), so off is stored as an
// explicit false: an omitted key would read as on again. The write
// protocol is useClientConfigPatch's.
import { useClientConfigPatch } from "./useClientConfigPatch";

export function useKeepReachableUpdate() {
  return useClientConfigPatch(
    (next: boolean) => ({ keepReachable: next }),
    "Couldn't update device reachability",
  );
}
