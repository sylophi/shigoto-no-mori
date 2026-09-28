import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChipButton } from "@/components/ui/chip-button";
import { useOutdatedDevices, useUpdateAll } from "@/hooks/system/useUpdater";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";

// Updates every device behind the newest release (useOutdatedDevices),
// from the head of the Settings page's device list, the chore of
// walking them one section at a time. Its count can pass the rows'
// update dots, which mark staged updates only: a device that hasn't
// fetched the release yet counts too, and fetches it and restarts once
// it's staged. Only there while two or more
// devices are behind. It restarts other machines, so it asks for the
// second click a single remote restart does. `chip` draws it for the
// phone layout's chip row.
export function UpdateAllButton({ chip = false }: { chip?: boolean }) {
  const { outdated } = useOutdatedDevices();
  const install = useUpdateAll(outdated);
  const confirm = useConfirmTwice(CONFIRM_QUICK_MS);
  const count = Object.keys(outdated).length;
  if (count < 2) return null;
  const common = {
    disabled: install.isPending,
    "aria-pressed": confirm.armed,
    title: `Update ${count} devices, downloading the update first where needed`,
    onClick: () => confirm.trigger(() => install.mutate()),
    children: (
      <>
        {install.isPending ? (
          <Loader2 aria-hidden className="size-3 animate-spin" />
        ) : (
          <RefreshCw aria-hidden className="size-3" />
        )}
        {confirm.armed ? "Click again to confirm" : "Update all"}
      </>
    ),
  };
  return chip ? (
    <ChipButton {...common} className="shrink-0 py-1.5" />
  ) : (
    <Button
      {...common}
      variant="ghost"
      size="xs"
      // The group label's own type size, so the pair reads as one line.
      className="-my-0.5 h-5 gap-1 px-1.5 text-3xs text-muted-foreground/80 [&_svg]:size-2.5"
    />
  );
}
