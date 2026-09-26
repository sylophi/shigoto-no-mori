import { useQuery } from "@tanstack/react-query";
import type { WorktreeFile } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { gatedHostReadMeta } from "@/lib/queryClientOptions";

// One file of a worktree for the files page's viewer. Nothing watches
// plain files for edits, so it goes stale in seconds and is refetched
// on mount and focus: coming back from an editor shows what was saved.
export function useWorktreeFile(
  projectId: string,
  worktreeId: string,
  path: string,
) {
  const { api, keys, remote } = useHostScope();
  return useQuery<WorktreeFile>({
    queryKey: keys.worktreeFile(projectId, worktreeId, path),
    queryFn: () => api.worktrees.readFile({ projectId, worktreeId, path }),
    // Long enough that stepping between files already looked at doesn't
    // read (and, from a peer, ship) each one again.
    staleTime: 5_000,
    // Every file looked at leaves its contents behind (up to the read
    // cap each), so only a recent one is kept for an instant second look.
    gcTime: 60_000,
    // The pane says so itself, and a peer without the grant refusing
    // is a state, not an error.
    meta: gatedHostReadMeta(remote, "Couldn't read file"),
  });
}
