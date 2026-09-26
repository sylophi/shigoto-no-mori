import { Download, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveButton } from "@/components/ui/confirm-destructive-button";
import { useVillagerData } from "@/hooks/villagers/useVillagerData";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { cn } from "@/lib/utils";
import { villagerDataView } from "./villagerDataView";

// The villager data, beside the Village life row: download it, follow
// the download, remove it. Host-scoped like the rest of the section, so
// a peer's tab manages that device's copy (and is inert there without
// its grant, like every row beside it). Village life above it stays
// locked until the download is complete.
//
// Removing takes a second click, like the app's other removals of
// something that costs a trip to get back (a project from the list):
// the data is a download from a community wiki, not a local link.
export function VillagerDataControl({
  doubutsuNames,
}: {
  // The form's switch, so the control follows it before a save.
  doubutsuNames: boolean;
}) {
  const { status, download, cancel, remove } = useVillagerData();
  const confirmRemove = useConfirmTwice(CONFIRM_QUICK_MS);
  // Nothing to say until the status is known, or when the device can't
  // answer (an older build).
  if (status === undefined) return null;

  const view = villagerDataView(status);
  const action = view.action === "remove" ? undefined : ACTIONS[view.action];
  // Names off only holds back a download: stopping one and removing
  // the data stay open.
  const waiting =
    !doubutsuNames && view.action !== "cancel" && view.action !== "remove";
  const disabled =
    waiting || download.isPending || cancel.isPending || remove.isPending;

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col items-end gap-1.5",
        waiting && "opacity-50",
      )}
    >
      <div className="flex items-center gap-x-3">
        {view.text && (
          <p className="max-w-80 text-right text-xs text-muted-foreground tabular-nums select-text">
            {view.text}
          </p>
        )}
        {action === undefined ? (
          <ConfirmDestructiveButton
            armed={confirmRemove.armed}
            pending={remove.isPending}
            pendingLabel="Removing…"
            idleLabel="Remove"
            disabled={disabled}
            onClick={() => confirmRemove.trigger(() => remove.mutate())}
          />
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() =>
              view.action === "cancel" ? cancel.mutate() : download.mutate()
            }
          >
            <action.Icon />
            {action.label}
          </Button>
        )}
      </div>
      {view.progress !== undefined && (
        <div
          role="progressbar"
          aria-label="Villager data download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(view.progress * 100)}
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${view.progress * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}

// Every action but Remove, which takes the app's two-click delete.
const ACTIONS = {
  download: { Icon: Download, label: "Download" },
  retry: { Icon: RefreshCw, label: "Try again" },
  cancel: { Icon: X, label: "Cancel" },
} as const;
