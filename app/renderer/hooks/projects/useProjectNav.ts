// Scope-aware navigation for the project pages (new worktree,
// configure, branches, convert external, worktree location). Each lives
// under /devices/$deviceId, so a link into one targets the device the
// current host scope names. The worktree-page counterpart is
// useWorktreeNav; this is the same seam for the pages that scope to a
// project alone.
import { useNavigate, useParams } from "@tanstack/react-router";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { PROJECT_ROUTE_PATHS } from "@/lib/routePaths";

// The project pages' params, read non-strictly for the same reason
// useScopedWorktreeParams does: the router can only type params
// against one route, and the pages share these across five.
export function useScopedProjectParams() {
  return useParams({ strict: false }) as { projectId: string };
}

export type ProjectPage = keyof typeof PROJECT_ROUTE_PATHS;

export function useProjectNav() {
  const navigate = useNavigate();
  const { deviceId } = useHostScope();

  return {
    // One of the project pages, on the device this scope names. Same
    // single cast as useWorktreeNav's `goOn`, for the same reason.
    toProjectPage(page: ProjectPage, projectId: string) {
      void navigate({
        to: PROJECT_ROUTE_PATHS[page],
        params: { deviceId, projectId },
      } as never);
    },
  };
}
