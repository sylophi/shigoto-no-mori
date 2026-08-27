import { SectionHeading } from "@/components/ui/section-heading";
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

// "This device": how this machine stays available to the account's
// other devices. Written immediately through the client store, never
// staged in a form — flipping it is the whole action.
export function ReachableSection() {
  const { data: clientConfig } = useClientConfig();
  const keepReachableUpdate = useKeepReachableUpdate();
  const keepReachable = clientConfig?.keepReachable === true;

  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">This device</SectionHeading>
      <ToggleRow
        checked={keepReachable}
        onCheckedChange={(next) => keepReachableUpdate.mutate(next)}
        disabled={keepReachableUpdate.isPending}
        label="Keep this device reachable"
        description={
          launchAtLoginSupported
            ? "Starts Shigoto no Mori when you log in and relaunches it after a recoverable crash, so this machine stays available to your account. Applies to this machine only."
            : "Relaunches Shigoto no Mori after a recoverable crash so this machine stays available to your account. Starting automatically at login isn't supported on this platform. Applies to this machine only."
        }
      />
    </section>
  );
}
