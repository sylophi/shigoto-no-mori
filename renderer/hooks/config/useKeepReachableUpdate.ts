// Immediate writer for the keepReachable opt-in.
// Unlike appearance, which stages in the settings form and persists on
// Save, this toggle takes effect at once: flipping it should register or
// clear the OS login item right away, which the main-side write handler
// does when the value changes. keepReachable is off by default, so it
// is stored only when explicitly on (undefined omits it). The write
// protocol is useClientConfigPatch's.
import { useClientConfigPatch } from "./useClientConfigPatch";

export function useKeepReachableUpdate() {
  return useClientConfigPatch(
    (next: boolean) => ({ keepReachable: next ? true : undefined }),
    "Couldn't update device reachability",
  );
}
