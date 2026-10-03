// "Keep this device reachable": the one device fact the account's OTHER
// machines depend on, so it belongs to THIS device's registry row
// rather than to a lone section at the bottom of the page. Indented
// under the row it modifies, it reads as a property of that machine --
// which is exactly what it is, and what the copy has to keep saying
// ("applies to this machine only") when the control floats free.
//
// Written immediately through the client store, never staged in a form:
// flipping it is the whole action. KeepReachableToggleView draws it.
import { keepReachableOn } from "@shared/schemas/config";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { useKeepReachableUpdate } from "@/hooks/config/useKeepReachableUpdate";
import { KeepReachableToggleView } from "./KeepReachableToggleView";

// Launch-at-login via setLoginItemSettings only takes on macOS and
// Windows. It is a no-op on Linux in Electron. The crash-recovery half
// of keepReachable works everywhere, so the toggle stays enabled and the
// helper text is what stays honest about the login-item half.
const launchAtLoginSupported =
  typeof navigator !== "undefined" &&
  /Macintosh|Windows/.test(navigator.userAgent);

export function KeepReachableToggle() {
  const { data: clientConfig } = useClientConfig();
  const keepReachableUpdate = useKeepReachableUpdate();
  return (
    <KeepReachableToggleView
      checked={keepReachableOn(clientConfig ?? {})}
      pending={keepReachableUpdate.isPending}
      launchAtLoginSupported={launchAtLoginSupported}
      onChange={(next) => keepReachableUpdate.mutate(next)}
    />
  );
}
