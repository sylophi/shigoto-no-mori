import { Outlet } from "@tanstack/react-router";
import { TerminalDrawer } from "@/components/terminal/TerminalDrawer";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { useDrawerSide } from "@/store/terminalDrawer";
import { worktreeKey } from "@/store/worktreeState";
import { WorktreePagesView } from "@shigomori/ui/views/worktreeDetail/WorktreePagesView.tsx";

// The layout of a worktree's pages, which keeps its terminal drawer
// mounted while they change, so its shells stay attached.
export function WorktreePages() {
  const { deviceId } = useHostScope();
  const { projectId, worktreeId, worktree } = useRouteWorktree();
  const side = useDrawerSide();
  return (
    <WorktreePagesView
      side={side}
      drawer={
        worktree && (
          <TerminalDrawer
            key={worktreeKey({ deviceId, projectId, worktreeId })}
            worktree={worktree}
          />
        )
      }
    >
      <Outlet />
    </WorktreePagesView>
  );
}
