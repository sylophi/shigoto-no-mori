import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ShigomoriWorktreeData } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useWorktreeData(
  projectId: string | null,
  worktreeId: string | null,
) {
  const { api, keys } = useHostScope();
  return useQuery<ShigomoriWorktreeData | null>({
    queryKey: keys.worktreeData(projectId, worktreeId),
    queryFn: () => {
      if (!projectId || !worktreeId) return null;
      return api.worktreeData.read(projectId, worktreeId);
    },
    enabled: projectId !== null && worktreeId !== null,
    meta: { errorTitle: "Couldn't load worktree state" },
  });
}

interface WriteVariables {
  projectId: string;
  worktreeId: string;
  data: ShigomoriWorktreeData;
}

export function useWorktreeDataWrite() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation({
    mutationFn: async ({ projectId, worktreeId, data }: WriteVariables) => {
      await api.worktreeData.write(projectId, worktreeId, data);
      return { projectId, worktreeId };
    },
    onSuccess: ({ projectId, worktreeId }) => {
      queryClient.invalidateQueries({
        queryKey: keys.worktreeData(projectId, worktreeId),
      });
    },
    meta: { errorTitle: "Couldn't save worktree state" },
  });
}
