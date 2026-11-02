import { useQueryClient } from "@tanstack/react-query";
import type { Worktree } from "@shigomori/contracts/schemas";
import { hostScopeOf } from "@/hooks/remote/useHostScope";
import { worktreePortsView } from "@/hooks/ports/useWorktreePorts";
import { packageScriptsQuery } from "@/hooks/scripts/usePackageScripts";
import { treeView } from "@/hooks/worktrees/useWorktreeChanges";
import { prefetchAhead } from "@/lib/queryClientOptions";
import { useRegistry } from "@/lib/runtime/viewHooks";
import { useApi } from "@/lib/runtime/pageApi";

// Starts the reads whose answers lay out a worktree's page (its scripts,
// commits and ports), so the page opens whole instead of filling in
// section by section. A view keeps streaming for its idle minute after
// the brief mount here, which is what the page then finds. `deviceId`
// is the device the worktree lives on, this one's when absent.
export function useWarmWorktreePage() {
  const page = useApi();
  const registry = useRegistry();
  const queryClient = useQueryClient();
  return (deviceId: string | undefined, worktree: Worktree) => {
    const on = deviceId ?? page.deviceId;
    const scope = hostScopeOf(page, registry, on);
    if (!scope?.hasHost) return;
    const { projectId, id: worktreeId } = worktree;
    registry.mount(
      treeView(on, "watchBranchHistory", { projectId, worktreeId }),
    )();
    registry.mount(worktreePortsView(on, worktree))();
    prefetchAhead(
      queryClient,
      packageScriptsQuery(scope, projectId, worktreeId),
    );
  };
}
