import { basename } from "node:path";
import type { Project, Worktree } from "@shared/schemas";
import {
  deleteWorktreeData,
  readWorktreeData,
  writeWorktreeData,
} from "../config/project";
import {
  describeWorktree,
  findWorktreeIdentityOrThrow,
  relocateWorktree,
  worktreeIdFromPath,
} from "../git/worktrees";
import {
  clearDeleteInflight,
  getInflightDeleteIds,
  killScriptsForWorktree,
  markDeleteInflight,
} from "../scripts";
import { pruneEmptyManagedParents } from "./paths";
import { dropShelved, isShelved, setShelved } from "./shelved";

export async function relocateWorktreeToManagedPath(
  project: Project,
  worktreeId: string,
  destinationPath: string,
): Promise<Worktree> {
  const target = await findWorktreeIdentityOrThrow(
    project.id,
    project.path,
    worktreeId,
  );
  if (target.isPrimary) {
    throw new Error("The primary checkout can't be relocated");
  }
  if (target.path === destinationPath) {
    // Already where it should be; refresh the row but skip the move.
    return describeWorktree(target, project.path);
  }
  // Same inflight marking as deletes: a quit mid-`git worktree move`
  // deserves the busy prompt, a concurrent delete must not interleave,
  // and a create lifecycle still running for this worktree must stop
  // rather than spawn steps into the old (now moving) path.
  if (getInflightDeleteIds().has(worktreeId)) {
    throw new Error("This worktree is already being removed or moved.");
  }
  markDeleteInflight(worktreeId);
  try {
    // Reap scripts running with the old worktree as cwd before the move.
    // Otherwise the process keeps running in the moved directory while the
    // renderer drops the run state on success, leaving an unmanageable
    // child until app quit. Matches the delete operation.
    const [, carryData] = await Promise.all([
      killScriptsForWorktree(worktreeId),
      readWorktreeData(project.id, worktreeId),
    ]);
    // The id is path-derived, so the relocate changes it -- carry the shelf
    // flag and per-worktree state forward to the new id.
    const carryShelved = isShelved(worktreeId);
    await relocateWorktree(project.path, target.path, destinationPath);
    // Sweep the old parent dir if it's one we own (managed root's
    // per-project subdir, or the in-project .shigomori scaffolding).
    // The custom layout is deliberately skipped: the directory there is
    // user-chosen and could sit next to unrelated files. Best effort:
    // failures are swallowed so concurrent moves don't race.
    await pruneEmptyManagedParents(target.path, project.path);
    const newId = worktreeIdFromPath(destinationPath);
    if (carryShelved) {
      dropShelved(worktreeId);
      setShelved(newId, true);
    }
    if (carryData) {
      await Promise.all([
        writeWorktreeData(project.id, newId, carryData),
        deleteWorktreeData(project.id, worktreeId),
      ]);
    }
    // Everything we need for the moved identity is already known: the id is
    // path-derived, branch/detached survive the move, and we just moved it
    // into a managed prefix the user picked. Skipping the post-move
    // `git worktree list` keeps the relocate batch fast.
    return describeWorktree(
      {
        ...target,
        id: newId,
        name: basename(destinationPath),
        path: destinationPath,
        isExternal: false,
      },
      project.path,
    );
  } finally {
    clearDeleteInflight(worktreeId);
  }
}
