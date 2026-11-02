import { useQueryClient } from "@tanstack/react-query";
import type { ChangedFile, Worktree } from "@shigomori/contracts/schemas";
import { ticksByHunk } from "@shigomori/ui/views/diff/changesControls.ts";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  commitMessageQueryOptions,
  treeView,
} from "@/hooks/worktrees/useWorktreeChanges";
import {
  commitDiffQuery,
  fileDiffInput,
  stashDiffQuery,
} from "@/hooks/worktrees/useWorktreeDiff";
import { prefetchAhead } from "@/lib/queryClientOptions";
import { firstValueOf, useRegistry } from "@/lib/runtime/viewHooks";

// Starts the reads a Git page opens on, for the ways into it from the
// scoped device's pages: a changed file's diff (and its hunks, where it
// ticks by hunk), a commit's diff and message, a stash's contents. A
// file's views stream on for their idle seconds after the brief mount
// here, and the diffs are kept, which is what the page then finds.
export function useWarmGitPages(worktree: Worktree) {
  const scope = useHostScope();
  const { deviceId, hasHost } = scope;
  const { canCommand } = useCommandAccess();
  const registry = useRegistry();
  const queryClient = useQueryClient();
  const { projectId, id: worktreeId } = worktree;

  const file = (changed: ChangedFile) => {
    if (!hasHost) return;
    registry.mount(
      treeView(
        deviceId,
        "watchFileDiff",
        fileDiffInput(projectId, worktreeId, changed),
      ),
    )();
    if (canCommand && ticksByHunk(changed)) {
      registry.mount(
        treeView(deviceId, "watchFileHunks", {
          projectId,
          worktreeId,
          path: changed.path,
        }),
      )();
    }
  };

  return {
    file,
    // The changes page, which opens on the first changed file: once
    // the changes are read, at once where they are (the worktree's
    // page).
    changes: () => {
      if (!hasHost) return;
      const status = treeView<readonly ChangedFile[]>(
        deviceId,
        "watchChangeStatus",
        { projectId, worktreeId },
      );
      void firstValueOf(registry, status).then((files) => {
        const first = files?.[0];
        if (first) file(first);
      });
    },
    commit: (hash: string) => {
      if (!hasHost) return;
      prefetchAhead(
        queryClient,
        commitDiffQuery(scope, projectId, worktreeId, hash),
      );
      prefetchAhead(
        queryClient,
        commitMessageQueryOptions(scope, projectId, worktreeId, hash),
      );
    },
    stash: (hash: string) => {
      if (!hasHost) return;
      prefetchAhead(
        queryClient,
        stashDiffQuery(scope, projectId, worktreeId, hash),
      );
    },
  };
}
