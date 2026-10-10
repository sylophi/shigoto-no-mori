// The worktree page's Ports section: the worktree's ports (PortList),
// between the branch and the scripts. Gone when there is nothing to
// show and nothing to add: no ports on a worktree the viewer cannot
// edit.
import type { Worktree } from "@shigomori/contracts/schemas";
import { PortActions, PortList, usePortList } from "./PortList";
import { PortsSectionView } from "@shigomori/ui/views/worktreeDetail/ports/PortsSectionView.tsx";

export function PortsSection({ worktree }: { worktree: Worktree }) {
  const state = usePortList(worktree);
  if (!state.canEdit && !state.isPending && state.ports.length === 0) {
    return null;
  }

  return (
    <PortsSectionView
      actions={<PortActions state={state} />}
      list={<PortList state={state} plain />}
    />
  );
}
