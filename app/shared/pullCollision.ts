import { pullLandingBranch, pullWorktreeName } from "./git/branches";
import type { Worktree } from "./schemas";

// Why a pull of a branch onto this device is refused up front, told
// once: the pull handler (host/ipc/modules/sync.ts) throws it, and the
// transplant review shows it before the user gets that far, so the
// two never drift apart.
// Why a pull under the source's folder name is refused up front: the
// name is taken here (a worktree of this project by that name, case-
// insensitively, or anything at the path), the same rule the CLI
// create applies (cli/worktree.go).
// `where` places the landing device when it is not the one speaking
// ("on Thinkpad"): the review of a flow to a peer, told from the
// sending side.
export function pullFolderCollision(
  name: string,
  path: string,
  where = "here",
): string {
  return `A folder named ${name} already exists ${where} (${path}). Remove or rename it first.`;
}

export function pullBranchCollision(
  branch: string,
  holderPath: string | undefined,
  where = "on this device",
): string {
  return holderPath === undefined
    ? `${branch} already exists ${where}. Delete that branch first, or open it and pull normally.`
    : `${branch} is already checked out at ${holderPath} ${where}. Stop or delete that worktree first.`;
}

// Where a pull would refuse at step 2 (host/ipc/modules/sync.ts
// runPullWorktree), worked out from the landing project's lists: the
// landing device already has the branch, checked out in a worktree or
// merely existing, or already has a worktree under the folder name the
// copy would take. The disk half of the folder rule (a stray folder
// that is no worktree) is the host's alone. With no landing project
// yet (a flow to a peer before its pick) nothing refuses. The branch
// asked about is the one the copy lands on (pullLandingBranch).
export function pullLandingCollision({
  worktree,
  projectName,
  localBranches,
  worktrees,
  where,
}: {
  // The worktree being pulled.
  worktree: Worktree;
  // The landing project, undefined while there is none, and its local
  // branches and worktrees (undefined until read).
  projectName: string | undefined;
  localBranches: readonly string[] | undefined;
  worktrees: readonly Worktree[] | undefined;
  // The landing device when it is not the one speaking ("on
  // Thinkpad"). This device keeps its own words.
  where?: string;
}): {
  // The branch the copy lands on.
  landingBranch: string;
  held: boolean;
  holder: Worktree | undefined;
  // The refusal the footer shows and Start waits on, or null.
  refusal: string | null;
} {
  const landingBranch = pullLandingBranch(worktree);
  const held = localBranches?.includes(landingBranch) ?? false;
  const holder = held
    ? worktrees?.find((entry) => entry.branch === landingBranch)
    : undefined;
  const name = pullWorktreeName(worktree);
  const taken =
    name !== undefined &&
    (worktrees?.some(
      (entry) => entry.name.toLowerCase() === name.toLowerCase(),
    ) ??
      false);
  const refusal =
    projectName === undefined
      ? null
      : held
        ? pullBranchCollision(landingBranch, holder?.path, where)
        : taken
          ? pullFolderCollision(name, `${projectName}/${name}`, where)
          : null;
  return { landingBranch, held, holder, refusal };
}
