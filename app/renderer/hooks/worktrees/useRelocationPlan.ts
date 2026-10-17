import { useQuery, skipToken } from "@tanstack/react-query";
import type {
  RelocationPlan,
  WorktreeLayout,
} from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

// Where the project's managed worktrees would go under a proposed
// layout, and which are there already, as the host judges it: by the
// folder, however its path is spelled. Asked again as the layout, the
// custom path or the worktrees' paths change; none while `ready` is
// false (a custom layout with no folder yet).
export function useRelocationPlan(
  projectId: string,
  layout: WorktreeLayout,
  customPath: string | null,
  paths: readonly string[],
  ready: boolean,
) {
  const { api, keys } = useHostScope();
  return useQuery<RelocationPlan>({
    queryKey: keys.relocationPlan(projectId, layout, customPath, paths),
    queryFn: ready
      ? ({ signal }) =>
          api.run(
            api.worktrees.relocationPlan({ projectId, layout, customPath }),
            { signal },
          )
      : skipToken,
    meta: { errorTitle: "Couldn't work out where the worktrees go" },
  });
}
