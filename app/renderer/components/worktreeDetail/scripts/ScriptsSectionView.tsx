// The worktree page's Scripts section (ScriptsSection binds it): the
// package.json scripts, then the lifecycle scripts the project runs
// around a worktree's life.
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ScriptListView } from "./ScriptListView";

export function ScriptsSectionView({
  loading,
  packageScripts,
  lifecycle,
  onConfigure,
}: {
  // The config or the scripts are still being read.
  loading: boolean;
  // The package.json scripts (PackageScripts), when there are any.
  packageScripts?: ReactNode;
  // The lifecycle rows (ScriptRow): setup, the port pool, teardown.
  lifecycle: ReactNode[];
  // With no lifecycle script, the way to set one up, on this device.
  onConfigure?: () => void;
}) {
  if (loading) {
    return (
      <div className="space-y-1" aria-label="Loading scripts">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {packageScripts}

      {lifecycle.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 pl-[18px] text-xs">
            <span className="font-mono text-muted-foreground">Lifecycle</span>
          </div>
          <ScriptListView>{lifecycle}</ScriptListView>
        </div>
      )}

      {lifecycle.length === 0 && onConfigure && (
        <button
          type="button"
          onClick={onConfigure}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Configure setup or teardown scripts →
        </button>
      )}
    </div>
  );
}
