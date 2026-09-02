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
// the same cache entry the section reads (the worktreesQueryOptions
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

// A patch over the stored document, or a function of it for edits that
// depend on what is there (the custom port list). Undefined values
// clear their key.
type WorktreeDataPatch =
  | Partial<ShigomoriWorktreeData>
  | ((current: ShigomoriWorktreeData) => Partial<ShigomoriWorktreeData>);

interface WriteVariables {
  projectId: string;
  worktreeId: string;
  patch: WorktreeDataPatch;
}

// The one writer of a worktree's data file. worktreeData:write is a
// full replace, so this merges the patch over the stored document
// (fetched through the cache if the page has not read it yet) and every
// caller only names its own keys: a notes save cannot drop the custom
// ports, and vice versa (the mergeClientConfigWrite rule, one layer
// over).
export function useWorktreeDataWrite() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation({
    // One scope for every worktree-data write in the app, so two edits
    // in flight at once (a remove clicked twice, a notes blur racing a
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
      await api.worktreeData.write(projectId, worktreeId, {
        ...current,
        ...(typeof patch === "function" ? patch(current) : patch),
      });
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
