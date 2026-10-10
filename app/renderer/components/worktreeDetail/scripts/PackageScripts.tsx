// The package.json scripts (PackageScriptsView), sorted and arranged on
// the worktree's host.
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import {
  useSetLaunchRowScript,
  useSetPackageScriptOrder,
  useSetPackageScriptSort,
  useSortedPackageScripts,
} from "@/hooks/scripts/usePackageScriptSort";
import type {
  PackageScriptsResult,
  Worktree,
} from "@shigomori/contracts/schemas";
import { PackageScriptsView } from "@shigomori/ui/views/worktreeDetail/scripts/PackageScriptsView.tsx";
import { ScriptRow } from "./ScriptRow";

export function PackageScripts({
  worktree,
  pkg,
}: {
  worktree: Worktree;
  pkg: PackageScriptsResult;
}) {
  const { sortMode, sorted } = useSortedPackageScripts(worktree.projectId, pkg);
  const setSortMode = useSetPackageScriptSort(worktree.projectId);
  const setOrder = useSetPackageScriptOrder(worktree.projectId);
  const setLaunchRow = useSetLaunchRowScript(worktree.projectId);
  const { canCommand } = useCommandAccess();
  return (
    <PackageScriptsView
      sortMode={sortMode}
      sorted={sorted}
      launchRow={pkg.launchRow}
      canCommand={canCommand}
      onSort={(mode) => setSortMode.mutate(mode)}
      onArrange={(names) => {
        setOrder.mutate([...names]);
        if (sortMode !== "manual") setSortMode.mutate("manual");
      }}
      onReorder={(names) => setOrder.mutate([...names])}
      onPin={(scriptName, onRow) => setLaunchRow.mutate({ scriptName, onRow })}
      renderRow={(entry) => (
        <ScriptRow
          key={entry.name}
          worktree={worktree}
          slot={{ kind: "package", name: entry.name }}
          label={entry.name}
          command={entry.command}
        />
      )}
    />
  );
}
