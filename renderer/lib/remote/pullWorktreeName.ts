// The folder a pulled (transplanted or mirrored) worktree lands under
// on this device: the source's own folder name (Worktree.name, the
// source host's basename of its path), so the two sides read as one
// worktree in every sidebar. Undefined when that name would not be a
// valid managed dirname (an external worktree in an odd folder), in
// which case the create picks a fresh pool name as it always did.
import { isValidWorktreeDirName } from "@shared/git/branches";
import type { Worktree } from "@shared/schemas";

export function pullWorktreeName(
  worktree: Pick<Worktree, "name">,
): string | undefined {
  return isValidWorktreeDirName(worktree.name) ? worktree.name : undefined;
}
