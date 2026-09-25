import { Skeleton } from "@/components/ui/skeleton";
import { useProjectNav } from "@/hooks/projects/useProjectNav";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { usePackageScripts } from "@/hooks/scripts/usePackageScripts";
import { usePortPoolActive } from "@/hooks/ports/usePortPoolActive";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { slotToParam, type ScriptSlot } from "@/store/scriptRuns";
import type { Worktree } from "@shared/schemas";
import { PackageScripts } from "./PackageScripts";
import { ScriptList } from "./ScriptList";
import { ScriptRow } from "./ScriptRow";

interface ScriptsSectionProps {
  worktree: Worktree;
}

export function ScriptsSection({ worktree }: ScriptsSectionProps) {
  // The rows run on whichever device the scope names (see
  // useScriptRunner). Only the local-page CTA below gates on the scope.
  const { remote } = useHostScope();
  const { toProjectPage } = useProjectNav();
  const { data: config, isLoading: configLoading } = useShigomoriConfig(
    worktree.projectId,
  );
  const { data: pkg, isLoading: pkgLoading } = usePackageScripts(
    worktree.projectId,
    worktree.id,
  );
  const { data: portPoolActive = false } = usePortPoolActive(
    worktree.projectId,
    worktree.id,
  );

  if (configLoading || pkgLoading) {
    return (
      <div className="space-y-1" aria-label="Loading scripts">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
      </div>
    );
  }

  const setupCommand = config?.scripts?.setup?.trim() ?? "";
  const teardownCommand = config?.scripts?.teardown?.trim() ?? "";
  const pkgHasScripts = pkg && Object.keys(pkg.scripts).length > 0;

  const lifecycleRows: { slot: ScriptSlot; label: string; command: string }[] =
    [];
  if (setupCommand) {
    lifecycleRows.push({
      slot: { kind: "setup" },
      label: "Setup",
      command: setupCommand,
    });
  }
  if (portPoolActive) {
    const quotedPath = worktreeQuotedPath(worktree.path);
    lifecycleRows.push({
      slot: { kind: "portPool", phase: "provision" },
      label: "Port-pool provision",
      command: `port-pool provision ${quotedPath}`,
    });
    lifecycleRows.push({
      slot: { kind: "portPool", phase: "release" },
      label: "Port-pool release",
      command: `port-pool release ${quotedPath}`,
    });
  }
  if (teardownCommand) {
    lifecycleRows.push({
      slot: { kind: "teardown" },
      label: "Teardown",
      command: teardownCommand,
    });
  }
  const hasLifecycle = lifecycleRows.length > 0;

  return (
    <div className="space-y-4">
      {/* Keyed so arranging (and the search) stays with the worktree it
          started in rather than following the page to the next one. */}
      {pkg && pkgHasScripts && (
        <PackageScripts key={worktree.id} worktree={worktree} pkg={pkg} />
      )}

      {lifecycleRows.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 pl-[18px] text-xs">
            <span className="font-mono text-muted-foreground">Lifecycle</span>
          </div>
          <ScriptList>
            {lifecycleRows.map((row) => (
              <ScriptRow
                key={slotToParam(row.slot)}
                worktree={worktree}
                slot={row.slot}
                label={row.label}
                command={row.command}
              />
            ))}
          </ScriptList>
        </div>
      )}

      {!hasLifecycle &&
        !remote && (
          // Configure is a local page, so the CTA only exists locally.
          <button
            type="button"
            onClick={() => toProjectPage("configure", worktree.projectId)}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Configure setup or teardown scripts →
          </button>
        )}
    </div>
  );
}

function worktreeQuotedPath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
