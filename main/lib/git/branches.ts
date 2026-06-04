import { type BranchList, isRealBranch } from "@shared/schemas";
import { run } from "./core";
import { listRemotes, localBranchExists, splitRemoteRefSync } from "./remotes";
import type { WorktreeIdentity } from "./worktrees";

// Rename the branch currently checked out in a worktree.
// `git branch -m <new>` renames the current HEAD branch.
export async function renameBranch(
  worktreePath: string,
  newBranch: string,
): Promise<void> {
  await run(worktreePath, ["branch", "-m", newBranch]);
}

// Switch a worktree to a different branch. Callers may hand us a
// remote-tracking ref like `origin/main` (e.g. when the primary branch
// resolves to a remote ref). `git checkout origin/main` would silently
// land on a detached HEAD rather than switching to the branch, so strip
// the remote prefix and let git DWIM into the local tracking branch,
// creating it if it doesn't exist yet. We only strip when no local branch
// of that exact name exists, so a real local branch that happens to look
// like `remote/thing` still wins. Callers that already hold the remote
// list can pass it to skip a redundant `git remote`.
export async function checkoutBranch(
  worktreePath: string,
  branch: string,
  remotes?: readonly string[],
): Promise<void> {
  let target = branch;
  if (!(await localBranchExists(worktreePath, branch))) {
    const split = splitRemoteRefSync(
      branch,
      remotes ?? (await listRemotes(worktreePath)),
    );
    if (split) target = split.branch;
  }
  await run(worktreePath, ["checkout", target]);
}

// Force-delete a local branch. Used after worktree removal when the
// global "deleteBranchOnRemove" setting is on. `git branch -D` refuses if
// the branch is checked out elsewhere, so safety against in-use branches
// is enforced by git itself.
export async function deleteLocalBranch(
  projectPath: string,
  branch: string,
): Promise<void> {
  await run(projectPath, ["branch", "-D", branch]);
}

// Centralizes the "delete the local branch after the worktree is gone"
// policy shared by per-worktree delete and the nuke-everything path:
// honor the global toggle, never touch externals (we didn't create the
// branch), skip placeholder branches, and swallow failures since the
// branch may be shared with another worktree or be the primary's HEAD --
// leaving it behind is always the safe fallback.
export async function deleteBranchAfterWorktreeRemoval(
  projectPath: string,
  identity: WorktreeIdentity,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  if (identity.isExternal) return;
  if (!isRealBranch(identity.branch)) return;
  try {
    await deleteLocalBranch(projectPath, identity.branch);
  } catch {
    // see comment above
  }
}

// Create a local branch pointing at `base` (or HEAD if omitted). When
// base is a remote-tracking ref, `--track` sets upstream automatically.
export async function createLocalBranch(
  projectPath: string,
  name: string,
  base: string | undefined,
): Promise<void> {
  const args = ["branch"];
  if (base?.includes("/")) args.push("--track");
  args.push(name);
  if (base) args.push(base);
  await run(projectPath, args);
}

// Rename any local branch (not necessarily the current one). `git branch
// -m <old> <new>` works even if `old` is checked out in a worktree —
// git updates that worktree's HEAD to the new name.
export async function renameAnyLocalBranch(
  projectPath: string,
  oldName: string,
  newName: string,
): Promise<void> {
  await run(projectPath, ["branch", "-m", oldName, newName]);
}

// Force-delete a local branch. Git still refuses if the branch is
// checked out in any worktree, which is the safety we care about.
export async function deleteAnyLocalBranch(
  projectPath: string,
  name: string,
): Promise<void> {
  await run(projectPath, ["branch", "-D", name]);
}

// `--directory` collapses fully-ignored directories into a single
// trailing-slash entry; loose files inside partially-ignored dirs are
// listed individually. The renderer derives membership from this list to
// decide whether a filesystem entry can be carried over.
export async function listIgnoredPaths(projectPath: string): Promise<string[]> {
  const stdout = await run(projectPath, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  return stdout.split("\n").filter((line) => line.length > 0);
}

// Lists branches usable as a base ref: local heads and remote-tracking refs.
// Symbolic refs like `origin/HEAD` are dropped — they alias another remote
// branch and would show up twice.
export async function listBranches(projectPath: string): Promise<BranchList> {
  const stdout = await run(projectPath, [
    "for-each-ref",
    "--format=%(refname)\t%(refname:short)\t%(symref)",
    "refs/heads/",
    "refs/remotes/",
  ]);
  const local: string[] = [];
  const remote: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [full, short, symref] = line.split("\t");
    if (!full || !short || symref) continue;
    if (full.startsWith("refs/heads/")) local.push(short);
    else if (full.startsWith("refs/remotes/")) remote.push(short);
  }
  return { local, remote };
}
