// Scope-aware navigation for the worktree detail tree. The same page
// components serve the local /projects/... routes and the
// /devices/$deviceId/projects/... twins, so their internal links must
// target whichever tree the current host scope lives in. Each helper
// branches on the scope and calls navigate with a literal route id, so
// the router's typed params stay fully checked in both arms.
import { useNavigate } from "@tanstack/react-router";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { localDeviceId } from "@/lib/queryKeys";

export function useWorktreeNav() {
  const navigate = useNavigate();
  const { deviceId } = useHostScope();
  const remote = deviceId !== localDeviceId;

  return {
    // True under a /devices/$deviceId twin route: local-only
    // affordances (configure, settings links, script consoles) gate on
    // this instead of re-deriving the scope comparison.
    remote,

    toWorktree(projectId: string, worktreeId: string, replace = false) {
      if (remote) {
        void navigate({
          to: "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId",
          params: { deviceId, projectId, worktreeId },
          replace,
        });
      } else {
        void navigate({
          to: "/projects/$projectId/worktrees/$worktreeId",
          params: { projectId, worktreeId },
          replace,
        });
      }
    },

    toDiff(projectId: string, worktreeId: string) {
      if (remote) {
        void navigate({
          to: "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId/diff",
          params: { deviceId, projectId, worktreeId },
        });
      } else {
        void navigate({
          to: "/projects/$projectId/worktrees/$worktreeId/diff",
          params: { projectId, worktreeId },
        });
      }
    },

    toCommit(projectId: string, worktreeId: string, hash: string) {
      if (remote) {
        void navigate({
          to: "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId/commits/$hash",
          params: { deviceId, projectId, worktreeId, hash },
        });
      } else {
        void navigate({
          to: "/projects/$projectId/worktrees/$worktreeId/commits/$hash",
          params: { projectId, worktreeId, hash },
        });
      }
    },

    toPrDiff(projectId: string, worktreeId: string) {
      if (remote) {
        void navigate({
          to: "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId/pr-diff",
          params: { deviceId, projectId, worktreeId },
        });
      } else {
        void navigate({
          to: "/projects/$projectId/worktrees/$worktreeId/pr-diff",
          params: { projectId, worktreeId },
        });
      }
    },

    // Explicitly the LOCAL tree, whatever the surrounding scope: a
    // brought-here or transplanted worktree lands on this machine, so
    // its detail page lives under /projects even when the action ran
    // from a remote page.
    toLocalWorktree(projectId: string, worktreeId: string) {
      void navigate({
        to: "/projects/$projectId/worktrees/$worktreeId",
        params: { projectId, worktreeId },
      });
    },

    // Where "leave this worktree's pages" lands: the device's forest
    // page remotely, home locally.
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
