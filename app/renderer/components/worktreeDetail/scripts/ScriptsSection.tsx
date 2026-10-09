import { useProjectNav } from "@/hooks/projects/useProjectNav";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { usePackageScripts } from "@/hooks/scripts/usePackageScripts";
import { usePortPoolActive } from "@/hooks/ports/usePortPoolActive";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { slotToParam, type ScriptSlot } from "@/store/scriptRuns";
import type { Worktree } from "@shigomori/contracts/schemas";
import { PackageScripts } from "./PackageScripts";
import { ScriptRow } from "./ScriptRow";
import { ScriptsSectionView } from "./ScriptsSectionView";

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
  return (
    <ScriptsSectionView
      loading={configLoading || pkgLoading}
      packageScripts={
        pkg &&
        pkgHasScripts && (
          // Keyed so arranging (and the search) stays with the worktree
          // it started in rather than following the page to the next one.
          <PackageScripts key={worktree.id} worktree={worktree} pkg={pkg} />
        )
      }
      lifecycle={lifecycleRows.map((row) => (
        <ScriptRow
          key={slotToParam(row.slot)}
          worktree={worktree}
          slot={row.slot}
          label={row.label}
          command={row.command}
        />
      ))}
      onConfigure={
        remote
          ? undefined
          : () => toProjectPage("configure", worktree.projectId)
      }
    />
  );
}

function worktreeQuotedPath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
