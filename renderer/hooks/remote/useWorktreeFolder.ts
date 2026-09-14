import { useQuery } from "@tanstack/react-query";
import type { SyncWorktreeFolderEntry } from "@shared/ipc/modules/sync";
import { useHostScope } from "@/hooks/remote/useHostScope";

// One folder of a worktree with git's ignore verdict per entry
// (sync:worktreeFolder), read against the scope's device: the mirror
// dialog browses the source's copy, the mirror's own page browses the
// local one. Dampened like the carry-over listing, since each read
// walks the checkout's ignored tree on the host.
export function useWorktreeFolder(
  projectId: string,
  worktreeId: string,
  relative: string,
) {
  const { api, keys } = useHostScope();
  return useQuery<SyncWorktreeFolderEntry[]>({
    queryKey: keys.worktreeFolder(projectId, worktreeId, relative),
    queryFn: () => api.sync.worktreeFolder({ projectId, worktreeId, relative }),
    staleTime: 15_000,
    meta: { errorTitle: "Couldn't read folder" },
  });
}
