// "Keep this device reachable": the one device fact the account's OTHER
// machines depend on, so it belongs to THIS device's registry row
// rather than to a lone section at the bottom of the page. Indented
// under the row it modifies, it reads as a property of that machine --
// which is exactly what it is, and what the copy has to keep saying
// ("applies to this machine only") when the control floats free.
//
// Written immediately through the client store, never staged in a form:
// flipping it is the whole action.
import { ToggleRow } from "@/components/settings/ToggleRow";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { useKeepReachableUpdate } from "@/hooks/config/useKeepReachableUpdate";

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
  const keepReachable = clientConfig?.keepReachable === true;

  return (
    <div className="mt-2.5 border-t border-border pt-2.5">
      <ToggleRow
        checked={keepReachable}
        onCheckedChange={(next) => keepReachableUpdate.mutate(next)}
        disabled={keepReachableUpdate.isPending}
        label="Keep this device reachable"
        description={
          launchAtLoginSupported
            ? "Starts Shigoto no Mori when you log in and relaunches it after a recoverable crash, so this machine stays available to your account."
            : "Relaunches Shigoto no Mori after a recoverable crash so this machine stays available to your account. Starting automatically at login isn't supported on this platform."
        }
      />
    </div>
  );
}
