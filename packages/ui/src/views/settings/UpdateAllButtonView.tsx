import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "../../primitives/button.tsx";

// Updates every device behind the newest release (useOutdatedDevices),
// from the end of the Settings General section's tab bar, the chore of
// walking the tabs one device at a time. Its count can pass the tabs'
// update dots, which mark staged updates only: a device that hasn't
// fetched the release yet counts too, and fetches it and restarts once
// it's staged. Only offered while two or more devices are behind
// (offersUpdateAll), which is useOutdatedDevices' `outdated`. It
// restarts other machines, so it asks for the second click a single
// remote restart does. It holds while the devices are on their way
// into the update, until they have restarted.
export function UpdateAllButtonView({
  armed,
  updating,
  onClick,
}: {
  armed: boolean;
  updating: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="xs"
      disabled={updating}
      aria-pressed={armed}
      onClick={onClick}
      // The loud fill of each device's own Restart to update, in the
      // tabs' pill shape at the row's height (DeviceTabBarView's trailing
      // slot stretches it), so it matches the tabs at either density.
      className="h-auto rounded-full px-2.5"
    >
      {updating ? (
        <Loader2 aria-hidden className="animate-spin" />
      ) : (
        <RefreshCw aria-hidden />
      )}
      {updating ? "Updating…" : armed ? "Click again to confirm" : "Update all"}
    </Button>
  );
}
