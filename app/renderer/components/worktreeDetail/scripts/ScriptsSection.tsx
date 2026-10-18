import type { LifecycleSlot } from "@shigomori/contracts/schemas/scripts";
import { lifecycleCommand } from "@shigomori/contracts/lifecycleScripts";
import { useProjectNav } from "@/hooks/projects/useProjectNav";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { usePackageScripts } from "@/hooks/scripts/usePackageScripts";
import { usePortPoolActive } from "@/hooks/ports/usePortPoolActive";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { slotToParam } from "@/store/scriptSlot";
import type { Worktree } from "@shigomori/contracts/schemas";
import { PackageScripts } from "./PackageScripts";
import { ScriptRow } from "./ScriptRow";
import { ScriptsSectionView } from "@shigomori/ui/views/worktreeDetail/scripts/ScriptsSectionView.tsx";

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

  const pkgHasScripts = pkg && Object.keys(pkg.scripts).length > 0;
  const lifecycleSlots: { slot: LifecycleSlot; label: string }[] = [
    { slot: { kind: "setup" }, label: "Setup" },
    ...(portPoolActive
      ? ([
          {
            slot: { kind: "portPool", phase: "provision" },
            label: "Port-pool provision",
          },
          {
            slot: { kind: "portPool", phase: "release" },
            label: "Port-pool release",
          },
        ] as const)
      : []),
    { slot: { kind: "teardown" }, label: "Teardown" },
  ];
  const lifecycleRows = lifecycleSlots.flatMap(({ slot, label }) => {
    const command = lifecycleCommand(slot, config, worktree.path);
    return command === "" ? [] : [{ slot, label, command }];
  });
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
