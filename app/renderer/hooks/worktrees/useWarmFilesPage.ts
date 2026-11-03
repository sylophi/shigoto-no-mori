import { useQueryClient } from "@tanstack/react-query";
import type { Worktree } from "@shigomori/contracts/schemas";
import { ancestorsOf } from "@shigomori/ui/views/files/treePaths.ts";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { worktreeFolderQuery } from "@/hooks/remote/useWorktreeFolder";
import { worktreeFileQuery } from "@/hooks/worktrees/useWorktreeFile";
import { rememberedFile } from "@/hooks/worktrees/useWorktreeNav";
import { prefetchAhead } from "@/lib/queryClientOptions";

// Starts the reads the files page opens on: a folder's listing, a
// file's contents, or the page as a whole, which is its top folder and
// the file it last showed with the folders down to it. Every one rides
// the command grant, so a peer that said no is left alone.
export function useWarmFilesPage(worktree: Worktree) {
  const scope = useHostScope();
  const { deviceId, hasHost } = scope;
  const { canCommand } = useCommandAccess();
  const queryClient = useQueryClient();
  const { projectId, id: worktreeId } = worktree;
  const reads = hasHost && canCommand;

  const folder = (relative: string) => {
    if (!reads) return;
    prefetchAhead(
      queryClient,
      worktreeFolderQuery(scope, projectId, worktreeId, relative, false),
    );
  };
  const file = (path: string) => {
    if (!reads) return;
    prefetchAhead(
      queryClient,
      worktreeFileQuery(scope, projectId, worktreeId, path),
    );
  };

  return {
    folder,
    file,
    page: () => {
      folder("");
      const last = rememberedFile({ deviceId, projectId, worktreeId });
      if (last === null) return;
      for (const ancestor of ancestorsOf(last)) folder(ancestor);
      file(last);
    },
  };
}
