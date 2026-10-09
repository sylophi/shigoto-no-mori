import { keepReachableOn } from "@shigomori/contracts/schemas/config";
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

// Written immediately through the client store.
export function KeepReachableToggle() {
  const { data: clientConfig } = useClientConfig();
  const keepReachableUpdate = useKeepReachableUpdate();
  return (
    <KeepReachableToggleView
      on={keepReachableOn(clientConfig ?? {})}
      pending={keepReachableUpdate.isPending}
      onChange={(next) => keepReachableUpdate.mutate(next)}
      launchAtLogin={launchAtLoginSupported}
    />
  );
}
