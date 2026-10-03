import { useProjectNav } from "@/hooks/projects/useProjectNav";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { usePackageScripts } from "@/hooks/scripts/usePackageScripts";
import { usePortPoolActive } from "@/hooks/ports/usePortPoolActive";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { slotToParam } from "@/store/scriptRuns";
import type { Worktree } from "@shared/schemas";
import { PackageScripts } from "./PackageScripts";
import { lifecycleRowsOf } from "./lifecycleRows";
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

  const lifecycle = lifecycleRowsOf({
    scripts: config?.scripts,
    portPoolActive,
    path: worktree.path,
  });
  const pkgHasScripts = pkg && Object.keys(pkg.scripts).length > 0;

  return (
    <ScriptsSectionView
      loading={configLoading || pkgLoading}
      packageScripts={
        // Keyed so arranging (and the search) stays with the worktree
        // it started in rather than following the page to the next one.
        pkg &&
        pkgHasScripts && (
          <PackageScripts key={worktree.id} worktree={worktree} pkg={pkg} />
        )
      }
      lifecycle={lifecycle}
      renderLifecycle={(row) => (
        <ScriptRow
          key={slotToParam(row.slot)}
          worktree={worktree}
          slot={row.slot}
          label={row.label}
          command={row.command}
        />
      )}
      offerConfigure={!remote}
      onConfigure={() => toProjectPage("configure", worktree.projectId)}
    />
  );
}
