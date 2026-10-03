// The Launch section's tool row as drawn (LauncherRow.tsx looks the
// tools up and launches them): a pill per tool, skeletons while the
// tools are detected, and a pointer to where tools come from when
// there are none.
import { Loader2 } from "lucide-react";
import { LauncherIcon } from "@/components/shared/LauncherIcon";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { LauncherEntry } from "@shared/schemas";

export function LauncherRowView({
  entries,
  loading = false,
  hiddenCount = 0,
  pendingId,
  onLaunch,
  onChooseTools,
  onConfigureTools,
}: {
  entries: LauncherEntry[];
  loading?: boolean;
  // Tools switched off in Settings.
  hiddenCount?: number;
  // The tool a launch is under way for.
  pendingId?: string;
  onLaunch?: (entry: LauncherEntry) => void;
  onChooseTools?: () => void;
  onConfigureTools?: () => void;
}) {
  if (loading) {
    return (
      <div
        className="flex flex-wrap items-center gap-2"
        aria-label="Detecting launchers"
      >
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
      </div>
    );
  }

  // Everything the user could launch is switched off in Settings, so point
  // there rather than at project Configure, which has no visibility toggles.
  if (entries.length === 0 && hiddenCount > 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Every launch tool is hidden.
        </p>
        <Button variant="outline" size="sm" onClick={onChooseTools}>
          Choose tools
        </Button>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          No tools detected and no custom tools configured.
        </p>
        <Button variant="outline" size="sm" onClick={onConfigureTools}>
          Configure tools
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {entries.map((entry) => (
        <Button
          key={entry.id}
          variant="outline"
          size="sm"
          onClick={() => onLaunch?.(entry)}
        >
          {pendingId === entry.id ? (
            <Loader2 className="animate-spin" />
          ) : (
            <LauncherIcon entry={entry} />
          )}
          <span>{entry.label}</span>
        </Button>
      ))}
    </div>
  );
}
