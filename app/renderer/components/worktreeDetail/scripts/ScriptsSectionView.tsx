// The Scripts section's body as drawn (ScriptsSection.tsx reads the
// scripts and the config): the package.json scripts
// (PackageScriptsView), the lifecycle rows, and on this machine's own
// page a pointer to Configure when there are no lifecycle scripts.
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { LifecycleRow } from "./lifecycleRows";
import { ScriptList } from "./ScriptList";
import { ScriptRowView } from "./ScriptRowView";

// A lifecycle script's row before any run.
function idleLifecycleRow(row: LifecycleRow) {
  return (
    <ScriptRowView key={row.label} label={row.label} command={row.command} />
  );
}

export function ScriptsSectionView({
  loading = false,
  packageScripts,
  lifecycle,
  renderLifecycle = idleLifecycleRow,
  offerConfigure = false,
  onConfigure,
}: {
  loading?: boolean;
  // The package.json part, absent when there are no scripts.
  packageScripts?: ReactNode;
  lifecycle: LifecycleRow[];
  // A live row per lifecycle script. An idle ScriptRowView when not
  // given.
  renderLifecycle?: (row: LifecycleRow) => ReactNode;
  // Whether to point at Configure when there are no lifecycle scripts
  // (Configure is a local page).
  offerConfigure?: boolean;
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
          <ScriptList>{lifecycle.map(renderLifecycle)}</ScriptList>
        </div>
      )}

      {lifecycle.length === 0 && offerConfigure && (
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
