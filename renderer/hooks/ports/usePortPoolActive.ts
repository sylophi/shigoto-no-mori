import { useQuery } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";

// An undefined worktree id (the caller is still finding the worktree
// to ask about) holds the read until there is one.
export function usePortPoolActive(
  projectId: string,
  worktreeId: string | undefined,
) {
  const { api, keys } = useHostScope();
  return useQuery<boolean>({
    queryKey: keys.portPoolActive(projectId, worktreeId ?? ""),
    queryFn: () =>
      api.portPool.isActive({ projectId, worktreeId: worktreeId ?? "" }),
    enabled: worktreeId !== undefined,
    meta: { errorTitle: "Couldn't check port-pool config" },
  });
}
