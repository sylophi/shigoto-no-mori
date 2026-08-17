import { basename } from "node:path";
import { sanitizeBranchForPath } from "@shared/branches";
import {
  CleanupErrorSchema,
  type DeleteWorktreeResult,
  type Project,
  type ScriptEvent,
  type Worktree,
  type WorktreeCarryOverComplete,
  type WorktreeLifecyclePhase,
} from "@shared/schemas";
import { readGlobalConfig } from "../config/global";
import {
  deleteWorktreeData,
  readShigomoriConfig,
  readWorktreeData,
  writeWorktreeData,
} from "../config/project";
import { deleteBranchAfterWorktreeRemoval } from "../git/branches";
import {
  createWorktree,
  describeWorktree,
  findWorktreeIdentityOrThrow,
  listWorktreeIdentities,
  relocateWorktree,
  removeWorktree,
  removeWorktreeForce,
  worktreeIdFromPath,
} from "../git/worktrees";
import {
  clearDeleteInflight,
  getInflightDeleteIds,
  killScriptsForWorktree,
  markDeleteInflight,
} from "../scripts";
import { runCreateLifecycle, runDeleteCleanup } from "./lifecycle";
import { pruneEmptyManagedParents } from "./paths";
import { dropShelved, isShelved, setShelved } from "./shelved";

export interface WorktreeOperationNotifiers {
  notifyPhase: (payload: WorktreeLifecyclePhase) => void;
  notifyCarryOverComplete: (payload: WorktreeCarryOverComplete) => void;
  notifyScript: (payload: ScriptEvent) => void;
}

interface CreateManagedWorktreeInput {
  worktreeName?: string;
  branchName?: string;
  base?: string;
  checkout?: boolean;
}

function spawnCreateLifecycle(
  label: string,
  project: Project,
  worktree: Worktree,
  notify: WorktreeOperationNotifiers,
): void {
  void runCreateLifecycle({
    project,
    worktree,
    notifyPhase: notify.notifyPhase,
    notifyCarryOverComplete: notify.notifyCarryOverComplete,
    notifyScript: notify.notifyScript,
  }).catch((err) => {
    console.error(`${label} lifecycle failed`, err);
  });
}

export async function createManagedWorktree(
  project: Project,
  input: CreateManagedWorktreeInput,
  notify: WorktreeOperationNotifiers,
): Promise<{ worktree: Worktree }> {
  const worktree = await createWorktree(project.id, project.path, {
    requestedWorktreeName: input.worktreeName,
    branchName: input.branchName,
    base: input.base,
    checkout: input.checkout ?? false,
  });
  // Fire-and-forget so the renderer can navigate to the new worktree
  // instantly. Carry-over, setup, and port-pool provision run in the
  // background; the renderer follows along via WorktreeLifecyclePhase
  // events and the sidebar activity icon driven by ScriptsEvent.
  spawnCreateLifecycle("create", project, worktree, notify);
  return { worktree };
}

export async function convertExternalWorktree(
  project: Project,
  worktreeId: string,
  notify: WorktreeOperationNotifiers,
): Promise<{ worktree: Worktree }> {
  const target = await findWorktreeIdentityOrThrow(
    project.id,
    project.path,
    worktreeId,
  );
  if (target.isPrimary) {
    throw new Error("The primary checkout can't be converted");
  }
  if (!target.isExternal) {
    throw new Error("Worktree is already shigomori-managed");
  }

  // The worktree's branch (or short hash, for a detached HEAD) is what
  // we'll re-check-out in the new managed location. Externals were
  // created outside shigomori, so we skip teardown / port-pool release
  // -- we never ran the matching provision on the way in. Force-remove
  // because the whole point of converting is to wipe whatever's in
  // the old directory and start fresh from the branch tip.
  const branchOrSha = target.branch;
  const worktreeName = target.detached
    ? branchOrSha
    : sanitizeBranchForPath(branchOrSha);

  // Same inflight marking as deletes: the old directory is force-removed
  // here, so a quit mid-conversion deserves the busy prompt, and a
  // concurrent delete of the same worktree must not interleave. The new
  // worktree gets a different path-derived id, so its create lifecycle
  // is unaffected by this mark.
  if (getInflightDeleteIds().has(worktreeId)) {
    throw new Error("This worktree is already being removed.");
  }
  // Refuse a name collision BEFORE the destructive wipe below --
  // createWorktree's own check runs after the old directory is already
  // force-removed, which would strand the user with neither checkout.
  // Case-insensitive to match createWorktree (NTFS / default APFS).
  if (worktreeName) {
    const identities = await listWorktreeIdentities(project.id, project.path);
    const taken = identities.some(
      (i) =>
        i.id !== worktreeId &&
        i.name.toLowerCase() === worktreeName.toLowerCase(),
    );
    if (taken) {
      throw new Error(
        `A worktree folder named "${worktreeName}" already exists in this project.`,
      );
    }
  }
  markDeleteInflight(worktreeId);
  try {
    await killScriptsForWorktree(worktreeId);
    await removeWorktreeForce(project.path, target.path);
    dropShelved(worktreeId);

    const worktree = await createWorktree(project.id, project.path, {
      requestedWorktreeName: worktreeName,
      base: branchOrSha,
      checkout: true,
    });
    spawnCreateLifecycle("convert-external", project, worktree, notify);
    return { worktree };
  } finally {
    clearDeleteInflight(worktreeId);
  }
}

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

interface DeleteWorktreeInput {
  worktreeId: string;
  force?: boolean;
  skipCleanup?: boolean;
}

export async function deleteWorktreeWithCleanup(
  project: Project,
  input: DeleteWorktreeInput,
  notify: Pick<WorktreeOperationNotifiers, "notifyScript">,
): Promise<DeleteWorktreeResult> {
  const { worktreeId } = input;
  // Mark the whole delete inflight -- cleanup scripts AND the removal
  // itself (a recursive rm on a big node_modules can take seconds) -- so
  // the busy-quit prompt can't let a quit interrupt it midway. The mark
  // also tombstones the worktree for runCreateLifecycle, stopping a
  // still-running create chain from spawning steps into a directory
  // that's going away. Marking up front (synchronously) doubles as the
  // guard against a second delete of the same worktree interleaving.
  if (getInflightDeleteIds().has(worktreeId)) {
    throw new Error("This worktree is already being removed.");
  }
  markDeleteInflight(worktreeId);
  try {
    return await deleteWorktreeWithCleanupInner(project, input, notify);
  } finally {
    clearDeleteInflight(worktreeId);
  }
}

async function deleteWorktreeWithCleanupInner(
  project: Project,
  input: DeleteWorktreeInput,
  notify: Pick<WorktreeOperationNotifiers, "notifyScript">,
): Promise<DeleteWorktreeResult> {
  const { worktreeId, force, skipCleanup } = input;
  const target = await findWorktreeIdentityOrThrow(
    project.id,
    project.path,
    worktreeId,
  );
  if (target.isPrimary) {
    throw new Error("Cannot delete the project's primary worktree");
  }
  if (!force) {
    const full = await describeWorktree(target, project.path);
    if (full.changedCount > 0) {
      throw new Error(
        `Worktree has ${full.changedCount} uncommitted change(s). Pass force=true to remove anyway.`,
      );
    }
  }

  const global = await readGlobalConfig();

  // Cleanup runs even on force-delete (force only bypasses the
  // uncommitted-changes guard, not teardown / port-pool release). External
  // worktrees were created outside shigomori, so we never ran setup or
  // port-pool provision for them -- skip the symmetric teardown / release
  // so we don't touch state we don't own. Electron's IPC strips structured
  // properties off thrown errors, so cleanup failures return a
  // discriminated result instead.
  if (skipCleanup !== true && !target.isExternal) {
    const [config, identities] = await Promise.all([
      readShigomoriConfig(project.id).catch(() => null),
      listWorktreeIdentities(project.id, project.path),
    ]);
    const projectBranch = identities.find((i) => i.isPrimary)?.branch ?? "";
    try {
      await runDeleteCleanup({
        project,
        worktree: target,
        projectBranch,
        config,
        globalPortPoolEnabled: global.portPool === true,
        notifyScript: notify.notifyScript,
      });
    } catch (err) {
      const parsed = CleanupErrorSchema.safeParse(err);
      if (parsed.success) {
        return { ok: false, cleanupError: parsed.data };
      }
      throw err;
    }
  }

  // Reap any package scripts still holding the worktree as cwd, then
  // remove. Force-delete routes through the wipe fallback so ENOTEMPTY
  // (untracked content git couldn't sweep) doesn't strand the user with a
  // half-removed worktree.
  await killScriptsForWorktree(worktreeId);
  if (force) {
    await removeWorktreeForce(project.path, target.path);
  } else {
    await removeWorktree(project.path, target.path, false);
  }
  // Same cleanup as relocate: if this was the last worktree under a
  // managed parent, sweep the empty dir away. Custom paths are left alone
  // since they're user-chosen.
  if (!target.isExternal) {
    await pruneEmptyManagedParents(target.path, project.path);
  }

  // Defaults to true: if you're done with the worktree, you're done with
  // the local branch. (Remote branches are never touched.)
  dropShelved(worktreeId);
  await Promise.all([
    deleteBranchAfterWorktreeRemoval(
      project.path,
      target,
      global.deleteBranchOnRemove ?? true,
    ),
    deleteWorktreeData(project.id, worktreeId),
  ]);
  return { ok: true };
}

export async function setWorktreeShelved(
  project: Project,
  worktreeId: string,
  shelved: boolean,
): Promise<Worktree> {
  const target = await findWorktreeIdentityOrThrow(
    project.id,
    project.path,
    worktreeId,
  );
  if (shelved && (target.isPrimary || target.isExternal)) {
    throw new Error(
      target.isPrimary
        ? "The primary checkout can't be shelved"
        : "External worktrees can't be shelved",
    );
  }
  setShelved(worktreeId, shelved);
  return describeWorktree(target, project.path);
}
