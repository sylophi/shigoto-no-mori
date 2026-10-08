import { useQuery } from "@tanstack/react-query";
import type { SyncWorktreeFolderEntry } from "@shigomori/contracts/modules/sync";
import { useHostScope } from "@/hooks/remote/useHostScope";

// One folder of a worktree with git's ignore verdict per entry
// (sync:worktreeFolder, which says what `ruleIgnored` adds), read
// against the scope's device: the mirror dialog browses the source's
// copy, the mirror's own page and the files page the local one.
// Dampened like the carry-over listing, since each read walks the
// checkout's ignored tree on the host.
export function useWorktreeFolder(
  projectId: string,
  worktreeId: string,
  relative: string,
  ruleIgnored: boolean,
) {
  const { api, keys } = useHostScope();
  return useQuery<readonly SyncWorktreeFolderEntry[]>({
    queryKey: keys.worktreeFolder(projectId, worktreeId, relative, ruleIgnored),
    queryFn: () =>
      api.sync.worktreeFolder({ projectId, worktreeId, relative, ruleIgnored }),
    staleTime: 15_000,
    meta: { errorTitle: "Couldn't read folder" },
  });
}
