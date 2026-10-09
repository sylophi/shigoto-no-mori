import {
  useScopedWorktreeParams,
  useWorktreeNav,
} from "@/hooks/worktrees/useWorktreeNav";
import { useEffect, useRef } from "react";
import { useProjects } from "@/hooks/projects/useProjects";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { WorktreeDetailInner } from "./WorktreeDetailInner";
import { WorktreeUnavailableView } from "./WorktreeDetailView";

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
  const nav = useWorktreeNav();

  // A worktree that vanishes from under its open page (a mirror stop
  // removed the copy, a peer tore its transplant source down here, a
  // terminal ran sm rm) leaves the page the way this page's own delete
  // does, instead of stranding it on "not found". Keyed on the route's
  // pair so a page that opened on a missing worktree is not sent away,
  // and a delete that already moved to a sibling is left alone.
  const key = `${projectId}/${worktreeId}`;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (worktree) {
      seen.current = key;
      return;
    }
    if (seen.current === key && !worktreesPending && !worktreesError) {
      seen.current = null;
      nav.toFallback([worktreeId], true);
    }
  }, [worktree, worktreesPending, worktreesError, key, worktreeId, nav]);

  useEffect(() => {
    // Local-only page-open work, once per worktree page opened:
    // refreshProject is a mutating invoke (an ungranted peer would
    // refuse it, and push invalidation plus the sweep requests already
    // keep a peer fresh).
    if (remote) return;
    void window.api.git.refreshProject({ projectId });
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
        <WorktreeUnavailableView onRetry={() => void refetchWorktrees()} />
      );
    }
    return <WorktreeUnavailableView />;
  }

  return (
    <WorktreeDetailInner
      worktree={worktree}
      project={project}
      siblings={worktrees}
    />
  );
}
