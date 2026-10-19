import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  CustomPort,
  ShigomoriWorktreeData,
} from "@shigomori/contracts/schemas";
import { useHostScope, type HostApi } from "@/hooks/remote/useHostScope";
import type { QueryKeyRegistry } from "@/lib/queryKeys";

function worktreeDataQueryOptions(
  api: HostApi,
  keys: QueryKeyRegistry,
  projectId: string,
  worktreeId: string,
) {
  return queryOptions<ShigomoriWorktreeData | null>({
    queryKey: keys.worktreeData(projectId, worktreeId),
    queryFn: ({ signal }) =>
      api.run(api.worktreeData.read({ projectId, worktreeId }), { signal }),
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

interface PortsPatchVariables {
  projectId: string;
  worktreeId: string;
  // Numbers to take away, then entries to set over one on their number.
  remove?: readonly number[];
  put?: readonly CustomPort[];
}

// Changes a worktree's custom ports by number (worktreeData:patchPorts),
// so a port another device or the terminal added meanwhile stays.
export function useWorktreePortsPatch() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation({
    mutationFn: async ({
      projectId,
      worktreeId,
      remove,
      put,
    }: PortsPatchVariables) => {
      await api.run(
        api.worktreeData.patchPorts({ projectId, worktreeId, remove, put }),
      );
      return { projectId, worktreeId };
    },
    onSuccess: ({ projectId, worktreeId }) => {
      // The port list is derived from this file, and its view reads it
      // again on the write.
      void queryClient.invalidateQueries({
        queryKey: keys.worktreeData(projectId, worktreeId),
      });
    },
    meta: { errorTitle: "Couldn't save worktree state" },
  });
}
