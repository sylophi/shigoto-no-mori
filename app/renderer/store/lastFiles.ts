import { createWorktreeStore, type WorktreeRef } from "./worktreeState";

// The file each worktree's Files page last showed this session, which
// the page opens on again unless it is asked for another.
const lastFiles = createWorktreeStore<string | null>({
  empty: null,
  moves: true,
});

export function rememberFile(ref: WorktreeRef, path: string | null): void {
  lastFiles.update(ref, () => path);
}

export const rememberedFile = (ref: WorktreeRef): string | null =>
  lastFiles.get(ref);
