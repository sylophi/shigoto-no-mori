import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ShigomoriWorktreeData } from "@shared/schemas";
import { useHostScope, type HostApi } from "@/hooks/remote/useHostScope";
import type { QueryKeyRegistry } from "@/lib/queryKeys";

// As options so the write below can fetch the stored document through
// the same cache entry the readers use (the worktreesQueryOptions
// precedent).
function worktreeDataQueryOptions(
  api: HostApi,
  keys: QueryKeyRegistry,
  projectId: string,
  worktreeId: string,
) {
  return queryOptions<ShigomoriWorktreeData | null>({
    queryKey: keys.worktreeData(projectId, worktreeId),
    queryFn: () => api.worktreeData.read(projectId, worktreeId),
    meta: { errorTitle: "Couldn't load worktree state" },
  });
}

export function useWorktreeData(
  projectId: string | null,
  worktreeId: string | null,
) {
  const { api, keys } = useHostScope();
  return useQuery({
    ...worktreeDataQueryOptions(api, keys, projectId ?? "", worktreeId ?? ""),
    enabled: projectId !== null && worktreeId !== null,
  });
}

// The new custom ports, or a function of the stored document for edits
// that depend on what is there. Undefined clears them.
type PortsPatch = Pick<ShigomoriWorktreeData, "ports">;
type WorktreeDataPatch =
  | PortsPatch
  | ((current: ShigomoriWorktreeData) => PortsPatch);

interface WriteVariables {
  projectId: string;
  worktreeId: string;
  patch: WorktreeDataPatch;
}

// The renderer's writer of a worktree's data file, which owns only the
// custom ports there (worktreeData:write). A patch can depend on what
// is stored, so it is given the document fetched fresh.
export function useWorktreeDataWrite() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation({
    // One scope for every worktree-data write in the app, so two edits
    // in flight at once (a remove clicked twice, a remove racing a
    // port add) run one after the other instead of each merging over
    // the same base and the later one undoing the earlier.
    scope: { id: "worktreeData" },
    mutationFn: async ({ projectId, worktreeId, patch }: WriteVariables) => {
      // Fetched fresh, never from the cache: the cache lags a just-landed
      // write until its invalidation refetch returns, and a merge over
      // that base would resurrect what the write removed.
      const current =
        (await queryClient.fetchQuery({
          ...worktreeDataQueryOptions(api, keys, projectId, worktreeId),
          staleTime: 0,
        })) ?? {};
      await api.worktreeData.write(
        projectId,
        worktreeId,
        typeof patch === "function" ? patch(current) : patch,
      );
      return { projectId, worktreeId };
    },
    onSuccess: ({ projectId, worktreeId }) => {
      void queryClient.invalidateQueries({
        queryKey: keys.worktreeData(projectId, worktreeId),
      });
      // The port list is derived from this file, so it moves with it.
      void queryClient.invalidateQueries({
        queryKey: keys.worktreePorts(projectId, worktreeId),
      });
    },
    meta: { errorTitle: "Couldn't save worktree state" },
  });
}
