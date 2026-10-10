// The branch switcher (BranchSwitcherView) over the project's branches,
// listed afresh each time it opens.
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BranchEntry } from "@shigomori/ui/views/shared/BranchComboboxView.tsx";
import { useBranches } from "@/hooks/git/useBranches";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useCheckoutBranch } from "@/hooks/worktrees/useWorktreeBranchOps";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { localBranchOf } from "@shared/git/branches";
import { isRealBranch, type Worktree } from "@shigomori/contracts/schemas";
import { BranchSwitcherView } from "./BranchSwitcherView";

export function BranchSwitcher({
  worktree,
  anchorRef,
  open,
  onOpenChange,
}: {
  worktree: Worktree;
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: branches, isFetching } = useBranches(worktree.projectId);
  const { data: peerWorktrees = [] } = useWorktrees(worktree.projectId);
  const checkout = useCheckoutBranch();
  const queryClient = useQueryClient();
  const { keys } = useHostScope();
  // A fresh list each time it opens.
  useEffect(() => {
    if (!open) return;
    void queryClient.invalidateQueries({
      queryKey: keys.branches(worktree.projectId),
    });
    void queryClient.invalidateQueries({
      queryKey: keys.worktrees(worktree.projectId),
    });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- on opening only
  }, [open]);

  // Exclude branches in use by *other* worktrees only; keeping this
  // worktree's own branch lets the popup show it with a check mark.
  const occupied = new Set<string>();
  for (const w of peerWorktrees) {
    if (w.id !== worktree.id && isRealBranch(w.branch)) occupied.add(w.branch);
  }
  // Local branches always shown; remotes only when no matching local
  // exists. Picking a remote orphan creates a local tracking branch
  // (main's checkoutBranch resolves the qualified ref, so which remote
  // was picked survives when several carry the same name).
  const localSet = new Set(branches?.local ?? []);
  const remoteSet = new Set(branches?.remote ?? []);
  const entries: BranchEntry[] = [];
  for (const name of branches?.local ?? []) {
    if (!occupied.has(name)) entries.push({ name, kind: "local" });
  }
  for (const name of branches?.remote ?? []) {
    if (!localSet.has(localBranchOf(name, remoteSet))) {
      entries.push({ name, kind: "remote" });
    }
  }
  return (
    <BranchSwitcherView
      branch={worktree.branch}
      entries={entries}
      fetching={isFetching}
      onPick={(branch) =>
        checkout.mutate({
          projectId: worktree.projectId,
          worktreeId: worktree.id,
          branch,
        })
      }
      anchorRef={anchorRef}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}
