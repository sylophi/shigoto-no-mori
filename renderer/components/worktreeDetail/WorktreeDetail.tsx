import { useScopedWorktreeParams } from "@/hooks/worktrees/useWorktreeNav";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { useProjects } from "@/hooks/projects/useProjects";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { recordRecentWorktree } from "@/lib/recentWorktrees";
import { WorktreeDetailInner } from "./WorktreeDetailInner";

export function WorktreeDetail() {
  const { projectId, worktreeId } = useScopedWorktreeParams();
  const { remote } = useHostScope();
  const { data: projects = [], isPending: projectsPending } = useProjects();
  const {
    data: worktrees = [],
    isPending: worktreesPending,
    isError: worktreesError,
    refetch: refetchWorktrees,
  } = useWorktrees(projectId);
  const project = projects.find((p) => p.id === projectId);
  const worktree = worktrees.find((w) => w.id === worktreeId);

  useEffect(() => {
    // Local-only page-open work: refreshProject is a mutating invoke
    // (an ungranted peer would refuse it, and auto-fetching on a peer
    // is chatty when push invalidation already keeps it fresh), and
    // the recent-worktrees list is this window's own quick-switcher.
    if (remote) return;
    void window.api.git.refreshProject(projectId);
    recordRecentWorktree(projectId, worktreeId);
  }, [projectId, worktreeId, remote]);

  if (!worktree || !project) {
    // Cold cache (e.g. a reload landing directly on this route): the
    // lists haven't resolved yet, so absence doesn't mean missing.
    if (worktreesPending || projectsPending) return null;
    // The worktrees query is silent on error because the sidebar owns
    // that message, so without this branch a failed listing would read
    // as a deleted worktree and offer no way back.
    if (worktreesError) {
      return (
        <CenteredMessage className="flex-col gap-3">
          Couldn't load worktrees.
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetchWorktrees()}
          >
            Retry
          </Button>
        </CenteredMessage>
      );
    }
    return <CenteredMessage>Worktree not found.</CenteredMessage>;
  }

  return (
    <WorktreeDetailInner
      worktree={worktree}
      project={project}
      siblings={worktrees}
    />
  );
}
