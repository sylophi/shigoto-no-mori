import { branchNotMergedError, errorMessageOf } from "@shared/errors";
import { type BranchList, isRealBranch } from "@shared/schemas";
import { run } from "./core";
import {
  listRemotes,
  localBranchExists,
  remoteRefExists,
  splitRemoteRefSync,
} from "./remotes";
import type { WorktreeIdentity } from "./worktrees";

// Rename the branch currently checked out in a worktree.
// `git branch -m <new>` renames the current HEAD branch.
export async function renameBranch(
  worktreePath: string,
  newBranch: string,
): Promise<void> {
  await run(worktreePath, ["branch", "-m", "--", newBranch]);
}

// Switch a worktree to a different branch. Callers may hand us a
// remote-tracking ref like `origin/main` (e.g. when the primary branch
// resolves to a remote ref). `git checkout origin/main` would land on a
// detached HEAD, so when the local branch doesn't exist yet we create a
// local tracking branch from the explicit remote ref via `--track`. Using
// the qualified ref (rather than a bare `git checkout main`) keeps the
// checkout unambiguous when several remotes share the branch name. An
// exact local branch always wins over the remote interpretation. Callers
// that already hold the remote list can pass it to skip a `git remote`.
export async function checkoutBranch(
  worktreePath: string,
  branch: string,
  remotes?: readonly string[],
): Promise<void> {
  // An exact local branch (including the rare literal "remote/thing") wins.
  if (await localBranchExists(worktreePath, branch)) {
    await run(worktreePath, ["checkout", branch]);
    return;
  }
  const split = splitRemoteRefSync(
    branch,
    remotes ?? (await listRemotes(worktreePath)),
  );
  // A qualified remote ref whose local branch doesn't exist yet: create the
  // tracking branch from the explicit ref so a name shared across remotes
  // stays unambiguous.
  if (split && !(await localBranchExists(worktreePath, split.branch))) {
    await run(worktreePath, ["checkout", "--track", branch]);
    return;
  }
  // Either a plain name git can DWIM, or the stripped local branch already
  // exists — switch to it.
  await run(worktreePath, ["checkout", split ? split.branch : branch]);
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
    await deleteAnyLocalBranch(projectPath, identity.branch, true);
  } catch {
    // see comment above
  }
}

// Create a local branch pointing at `base` (or HEAD if omitted). When
// base is a remote-tracking ref, `--track` sets upstream explicitly so
// the behavior doesn't depend on the user's branch.autoSetupMerge. A
// local base (even a slashed one like `feature/foo`) must not track --
// that would pin the new branch's upstream to a local ref. An exact
// local branch wins over the remote interpretation, matching
// checkoutBranch's precedence.
export async function createLocalBranch(
  projectPath: string,
  name: string,
  base: string | undefined,
): Promise<void> {
  const track = base
    ? !(await localBranchExists(projectPath, base)) &&
      (await remoteRefExists(projectPath, base))
    : false;
  const args = ["branch"];
  if (track) args.push("--track");
  args.push("--", name);
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
  await run(projectPath, ["branch", "-m", "--", oldName, newName]);
}

// Delete a local branch. Without `force` this is git's safe delete
// (`-d`), whose "not fully merged" refusal is rethrown as the shared
// branchNotMergedError so the renderer can offer a force retry. With
// `force` (`-D`), git still refuses if the branch is checked out in any
// worktree, which is the safety we care about.
export async function deleteAnyLocalBranch(
  projectPath: string,
  name: string,
  force: boolean,
): Promise<void> {
  try {
    await run(projectPath, ["branch", force ? "-D" : "-d", "--", name]);
  } catch (err) {
    // git's stderr wording is stable here because core.ts pins LC_ALL=C.
    if (!force && /not fully merged/.test(errorMessageOf(err))) {
      throw branchNotMergedError(name);
    }
    throw err;
  }
}

// `--directory` collapses fully-ignored directories into a single
// trailing-slash entry; loose files inside partially-ignored dirs are
// listed individually. `-z` keeps non-ASCII names raw instead of
// core.quotePath-escaped so they compare equal against
// filesystem-derived paths.
async function listOthersIgnored(
  projectPath: string,
  excludeArg: string,
): Promise<string[]> {
  const stdout = await run(projectPath, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    excludeArg,
    "--directory",
  ]);
  return stdout.split("\0").filter((line) => line.length > 0);
}

// Untracked paths ignored by the standard excludes (.gitignore et al).
// The renderer derives membership from this list to decide whether a
// filesystem entry can be carried over.
export async function listIgnoredPaths(projectPath: string): Promise<string[]> {
  return listOthersIgnored(projectPath, "--exclude-standard");
}

// Untracked paths matched by the gitignore-syntax patterns in
// `excludeFile` (absolute path). `--exclude-from` replaces the standard
// excludes as the pattern source, so this evaluates ONLY the given file's
// patterns, with full gitignore semantics including negation.
export async function listUntrackedMatchingExcludeFile(
  projectPath: string,
  excludeFile: string,
): Promise<string[]> {
  return listOthersIgnored(projectPath, `--exclude-from=${excludeFile}`);
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
