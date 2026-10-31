import { useEffect } from "react";
import { useProjects } from "@/hooks/projects/useProjects";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRenamingWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import { WorktreeDetailInner } from "./WorktreeDetailInner";
import { WorktreeUnavailableView } from "@shigomori/ui/views/worktreeDetail/WorktreeDetailView.tsx";
import { useApi } from "@/lib/runtime/pageApi";

export function WorktreeDetail() {
  const api = useApi();
  const { projectId, worktreeId, worktree, worktrees, nav, missing } =
    useRouteWorktree();
  const { remote, deviceId } = useHostScope();
  const { data: projects = [], isPending: projectsPending } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const renaming = useRenamingWorktree(deviceId, worktreeId);

  // A worktree that vanishes from under its open page (a mirror stop
  // removed the copy, a peer tore its transplant source down here, a
  // terminal ran sm rm) leaves the page the way this page's own delete
  // does, instead of stranding it on "not found". A page that opened on
  // a missing worktree is not sent away, and a delete that already
  // moved to a sibling is left alone.
  useEffect(() => {
    // A rename from here is under way: its answer takes the page on.
    if (renaming) return;
    if (missing.deleted && !missing.isPending && !missing.isError) {
      nav.toFallback([worktreeId], true);
    }
  }, [
    missing.deleted,
    missing.isPending,
    missing.isError,
    worktreeId,
    renaming,
    nav,
  ]);

  useEffect(() => {
    // Local-only page-open work, once per worktree page opened:
    // refreshProject is a mutating invoke (an ungranted peer would
    // refuse it, and push invalidation plus the sweep requests already
    // keep a peer fresh).
    if (remote) return;
    void api.run(api.git.refreshProject({ projectId }));
  }, [projectId, worktreeId, remote, api]);

  if (!worktree || !project) {
    // Cold cache (e.g. a reload landing directly on this route): the
    // lists haven't resolved yet, so absence doesn't mean missing.
    if (missing.isPending || projectsPending) return null;
    if (renaming) return null;
    // The worktrees query is silent on error because the sidebar owns
    // that message, so without this branch a failed listing would read
    // as a deleted worktree and offer no way back.
    if (missing.isError) {
      return <WorktreeUnavailableView onRetry={() => void missing.refetch()} />;
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
