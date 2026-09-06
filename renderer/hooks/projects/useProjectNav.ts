// Scope-aware navigation for the project pages (new worktree,
// configure, branches, convert external, worktree location). Each
// serves both its local /projects route and the /devices/$deviceId
// twin, so a link into one must target whichever tree the current host
// scope lives in. The worktree-page counterpart is useWorktreeNav;
// this is the same seam for the pages that scope to a project alone.
import { useNavigate, useParams } from "@tanstack/react-router";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { PROJECT_ROUTE_PATHS } from "@/lib/routePaths";

// The project pages' params, read non-strictly for the same reason
// useScopedWorktreeParams does: the router can only type params
// against one route, and each page serves two.
export function useScopedProjectParams() {
  return useParams({ strict: false }) as { projectId: string };
}

export type ProjectPage = keyof typeof PROJECT_ROUTE_PATHS;

export function useProjectNav() {
  const navigate = useNavigate();
  const { deviceId, remote } = useHostScope();

  return {
    remote,
    // One of the project pages, in whichever tree this scope lives in.
    // Same single cast as useWorktreeNav's `go`, for the same reason.
    toProjectPage(page: ProjectPage, projectId: string) {
      const paths = PROJECT_ROUTE_PATHS[page];
      void navigate({
        to: remote ? paths.remote : paths.local,
        params: remote ? { projectId, deviceId } : { projectId },
      } as never);
    },
  };
}
