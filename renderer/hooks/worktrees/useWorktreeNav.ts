// Scope-aware navigation for the worktree detail tree. The same page
// components serve the local /projects/... routes and the
// /devices/$deviceId/projects/... twins, so their internal links must
// target whichever tree the current host scope lives in. One `go`
// picks the twin and splices the device param; the paths themselves
// come from lib/routePaths so the route trees and these links cannot
// drift apart.
import { useNavigate } from "@tanstack/react-router";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { localDeviceId } from "@/lib/queryKeys";
import { WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";

export function useWorktreeNav() {
  const navigate = useNavigate();
  const { deviceId } = useHostScope();
  const remote = deviceId !== localDeviceId;

  // The local path and the remote twin differ only by the
  // /devices/$deviceId prefix and the param that fills it, so the two
  // arms every helper used to spell out collapse to this. The router
  // can only check params against ONE literal `to`, and this one is a
  // union of the pair, hence the single cast -- the paths come from the
  // same constants the route trees are built from, so a path the tree
  // doesn't serve still can't slip through.
  const go = (
    page: keyof typeof WORKTREE_ROUTE_PATHS,
    params: { projectId: string; worktreeId: string; hash?: string },
    replace = false,
  ) => {
    const paths = WORKTREE_ROUTE_PATHS[page];
    void navigate({
      to: remote ? paths.remote : paths.local,
      params: remote ? { ...params, deviceId } : params,
      replace,
    } as never);
  };

  return {
    // True under a /devices/$deviceId twin route: local-only
    // affordances (configure, settings links, script consoles) gate on
    // this instead of re-deriving the scope comparison.
    remote,

    toWorktree(projectId: string, worktreeId: string, replace = false) {
      go("detail", { projectId, worktreeId }, replace);
    },

    toDiff(projectId: string, worktreeId: string) {
      go("diff", { projectId, worktreeId });
    },

    toCommit(projectId: string, worktreeId: string, hash: string) {
      go("commit", { projectId, worktreeId, hash });
    },

    toPrDiff(projectId: string, worktreeId: string) {
      go("prDiff", { projectId, worktreeId });
    },

    // Explicitly the LOCAL tree, whatever the surrounding scope: a
    // brought-here or transplanted worktree lands on this machine, so
    // its detail page lives under /projects even when the action ran
    // from a remote page.
    toLocalWorktree(projectId: string, worktreeId: string) {
      void navigate({
        to: WORKTREE_ROUTE_PATHS.detail.local,
        params: { projectId, worktreeId },
      });
    },

    // Where "leave this worktree's pages" lands: the device's forest
    // page remotely, home locally. Not one of the twin pairs above: the
    // local arm is the root, not a /projects path.
    toFallback(replace = false) {
      if (remote) {
        void navigate({
          to: "/devices/$deviceId",
          params: { deviceId },
          replace,
        });
      } else {
        void navigate({ to: "/", replace });
      }
    },
  };
}
