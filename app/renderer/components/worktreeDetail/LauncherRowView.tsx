// The launch tools as a row of pills (LauncherRow binds them), or what
// to do when there are none to show.
import { Loader2 } from "lucide-react";
import { LauncherIconView } from "@shigomori/ui/views/shared/LauncherIconView.tsx";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { Skeleton } from "@shigomori/ui/primitives/skeleton.tsx";
import type { LauncherEntry } from "@shigomori/contracts/schemas";

export function LauncherRowView({
  entries,
  allHidden = false,
  pendingId,
  onLaunch,
  onChooseTools,
  onConfigure,
}: {
  // Undefined while the tools are detected.
  entries: readonly LauncherEntry[] | undefined;
  // Every tool there is is switched off in Settings.
  allHidden?: boolean;
  // The tool a launch is under way in.
  pendingId?: string;
  onLaunch: (entry: LauncherEntry) => void;
  onChooseTools: () => void;
  onConfigure: () => void;
}) {
  if (entries === undefined) {
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
  if (entries.length === 0 && allHidden) {
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
        <Button variant="outline" size="sm" onClick={onConfigure}>
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
          onClick={() => onLaunch(entry)}
        >
          {entry.id === pendingId ? (
            <Loader2 className="animate-spin" />
          ) : (
            <LauncherIconView entry={entry} />
          )}
          <span>{entry.label}</span>
        </Button>
      ))}
    </div>
  );
}
