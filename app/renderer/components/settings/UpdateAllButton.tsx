import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChipButton } from "@/components/ui/chip-button";
import { useUpdateAll } from "@/hooks/system/useUpdater";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";

// Restarts every device holding a staged update, from the head of the
// Settings page's device list: the rows under it carry the update dots
// it acts on, and walking them one section at a time is the chore it
// saves. Only there while two or more devices have one. It restarts
// other machines, so it asks for the second click a single remote
// restart does. `chip` draws it for the phone layout's chip row.
export function UpdateAllButton({
  updates,
  chip = false,
}: {
  // useStagedUpdates' answer, read once by the caller for the page.
  updates: Readonly<Record<string, string>>;
  chip?: boolean;
}) {
  const install = useUpdateAll(updates);
  const confirm = useConfirmTwice(CONFIRM_QUICK_MS);
  const count = Object.keys(updates).length;
  if (count < 2) return null;
  const common = {
    disabled: install.isPending,
    "aria-pressed": confirm.armed,
    title: `Restart ${count} devices into their updates`,
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
