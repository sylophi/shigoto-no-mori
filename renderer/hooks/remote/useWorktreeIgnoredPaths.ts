import { useQuery } from "@tanstack/react-query";
import type { SyncIgnoredPathsResult } from "@shared/ipc/modules/sync";
import { useHostScope } from "@/hooks/remote/useHostScope";

// The ignored files on a worktree, which a transfer leaves behind
// (sync:ignoredPaths): the first few names and the full count. Read
// against the scope's device, the source of a transplant, and read
// once: the dialog's two steps share the one answer, and it crosses
// the device link.
export function useWorktreeIgnoredPaths(projectId: string, worktreeId: string) {
  const { api, keys } = useHostScope();
  return useQuery<SyncIgnoredPathsResult>({
    queryKey: keys.worktreeIgnored(projectId, worktreeId),
    queryFn: () => api.sync.ignoredPaths({ projectId, worktreeId }),
    staleTime: Infinity,
    // The dialog says so inline, so a toast would only repeat it.
    meta: { silentError: true },
  });
}
