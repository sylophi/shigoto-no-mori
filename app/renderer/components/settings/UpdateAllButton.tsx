import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUpdateAll } from "@/hooks/system/useUpdater";
import type { OutdatedDevice } from "@/lib/updates";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";

// Updates every device behind the newest release (useOutdatedDevices),
// from the end of the Settings General section's tab bar, the chore of
// walking the tabs one device at a time. Its count can pass the tabs'
// update dots, which mark staged updates only: a device that hasn't
// fetched the release yet counts too, and fetches it and restarts once
// it's staged. Only offered while two or more devices are behind
// (offersUpdateAll), which is useOutdatedDevices' `outdated`. It
// restarts other machines, so it asks for the second click a single
// remote restart does.
export function UpdateAllButton({ outdated }: { outdated: Outdated }) {
  const install = useUpdateAll(outdated);
  const confirm = useConfirmTwice(CONFIRM_QUICK_MS);
  return (
    <Button
      size="xs"
      disabled={install.isPending}
      aria-pressed={confirm.armed}
      onClick={() => confirm.trigger(() => install.mutate())}
      // The loud fill of each device's own Restart to update, in the
      // tabs' pill shape at the row's height (DeviceTabBarView's trailing
      // slot stretches it), so it matches the tabs at either density.
      className="h-auto rounded-full px-2.5"
    >
      {install.isPending ? (
        <Loader2 aria-hidden className="animate-spin" />
      ) : (
        <RefreshCw aria-hidden />
      )}
      {confirm.armed ? "Click again to confirm" : "Update all"}
    </Button>
  );
}

type Outdated = Readonly<Record<string, OutdatedDevice>>;

// Whether Update all is worth offering: one device behind is its own
// Restart to update.
export function offersUpdateAll(outdated: Outdated): boolean {
  return Object.keys(outdated).length >= 2;
}
