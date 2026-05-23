import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ShigomoriWorktreeData } from "@shared/schemas";

function queryKey(projectId: string | null, worktreeId: string | null) {
  return ["worktreeData", projectId, worktreeId] as const;
}

export function useWorktreeData(
  projectId: string | null,
  worktreeId: string | null,
) {
  return useQuery<ShigomoriWorktreeData | null>({
    queryKey: queryKey(projectId, worktreeId),
    queryFn: () => {
      if (!projectId || !worktreeId) return null;
      return window.api.worktreeData.read(projectId, worktreeId);
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
  return useMutation({
    mutationFn: async ({ projectId, worktreeId, data }: WriteVariables) => {
      await window.api.worktreeData.write(projectId, worktreeId, data);
      return { projectId, worktreeId };
    },
    onSuccess: ({ projectId, worktreeId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKey(projectId, worktreeId),
      });
    },
    meta: { errorTitle: "Couldn't save worktree state" },
  });
}
