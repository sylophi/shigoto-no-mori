import { Download, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveButton } from "@/components/ui/confirm-destructive-button";
import type { villagerDataView } from "./villagerDataView";

// The villager data, beside the Village life row: download it, follow
// the download, remove it. This device's copy, in its data dir
// (host/lib/villagers.ts). Village life stays locked until the
// download is complete.
//
// Removing takes a second click, like the app's other removals of
// something that costs a trip to get back (a project from the list):
// the data is a download from a community wiki, not a local link.
export function VillagerDataControlView({
  view,
  armed,
  removePending,
  disabled,
  onRemove,
  onAction,
}: {
  // The data's state, as the control shows it (villagerDataView.ts).
  view: ReturnType<typeof villagerDataView>;
  // The removal asked for once.
  armed: boolean;
  removePending: boolean;
  disabled: boolean;
  onRemove: () => void;
  // Download, retry or cancel, as `view.action` says.
  onAction: () => void;
}) {
  const action = view.action === "remove" ? undefined : ACTIONS[view.action];

  return (
    <div className="flex shrink-0 flex-col items-end gap-1.5">
      <div className="flex items-center gap-x-3">
        {view.text && (
          <p className="max-w-80 text-right text-xs text-muted-foreground tabular-nums select-text">
            {view.text}
          </p>
        )}
        {action === undefined ? (
          <ConfirmDestructiveButton
            armed={armed}
            pending={removePending}
            pendingLabel="Removing…"
            idleLabel="Remove"
            disabled={disabled}
            onClick={onRemove}
          />
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={onAction}
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
