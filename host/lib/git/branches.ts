import { Effect } from "effect";
import { BranchNotMerged, branchNotMergedError } from "@shared/errors";
import { type BranchList, isRealBranch } from "@shared/schemas";
import { type GitFailure, runEffect, runGit, splitZ } from "./core";
import {
  listRemotesEffect,
  localBranchExistsEffect,
  remoteRefExistsEffect,
  splitRemoteRefSync,
} from "./remotes";
import type { WorktreeIdentity } from "./worktrees";

// Rename the branch currently checked out in a worktree.
// `git branch -m <new>` renames the current HEAD branch. Not
// interruptible: git renames the ref, then its config section, and a
// caller leaving between the two would leave the branch without its
// upstream.
export const renameBranchEffect = Effect.fn("branches.renameBranch")(function* (
  worktreePath: string,
  newBranch: string,
) {
  yield* Effect.uninterruptible(
    runEffect(worktreePath, ["branch", "-m", "--", newBranch]),
  );
});

// Switch a worktree to a different branch. Callers may hand us a
// remote-tracking ref like `origin/main` (e.g. when the primary branch
// resolves to a remote ref). `git checkout origin/main` would land on a
// detached HEAD, so when the local branch doesn't exist yet we create a
// local tracking branch from the explicit remote ref via `--track`. Using
// the qualified ref (rather than a bare `git checkout main`) keeps the
// checkout unambiguous when several remotes share the branch name. An
// exact local branch always wins over the remote interpretation. Callers
// that already hold the remote list can pass it to skip a `git remote`.
// `--end-of-options` pins the name to the revision slot and the trailing
// `--` keeps it out of the pathspec slot, so no caller-supplied name can
// be read as a flag or as a file.
//
// The lookups before the checkout are interruptible; the checkout is
// not. It rewrites the working tree, and a caller leaving partway
// (a dropped peer socket, a page reload) would kill git with the tree
// half rewritten and HEAD and the index unchanged, which shows up as
// hundreds of phantom modifications. Once it starts, it finishes.
export const checkoutBranchEffect = Effect.fn("branches.checkoutBranch")(
  function* (
    worktreePath: string,
    branch: string,
    remotes?: readonly string[],
  ) {
    // An exact local branch (including the rare literal "remote/thing") wins.
    if (yield* localBranchExistsEffect(worktreePath, branch)) {
      yield* checkout(worktreePath, ["--end-of-options", branch, "--"]);
      return;
    }
    const split = splitRemoteRefSync(
      branch,
      remotes ?? (yield* listRemotesEffect(worktreePath)),
    );
    // A qualified remote ref whose local branch doesn't exist yet: create the
    // tracking branch from the explicit ref so a name shared across remotes
    // stays unambiguous.
    if (
      split &&
      !(yield* localBranchExistsEffect(worktreePath, split.branch))
    ) {
      yield* checkout(worktreePath, [
        "--track",
        "--end-of-options",
        branch,
        "--",
      ]);
      return;
    }
    // Either a plain name git can DWIM, or the stripped local branch already
    // exists, so switch to it.
    yield* checkout(worktreePath, [
      "--end-of-options",
      split ? split.branch : branch,
      "--",
    ]);
  },
);

function checkout(worktreePath: string, args: readonly string[]) {
  return Effect.uninterruptible(runEffect(worktreePath, ["checkout", ...args]));
}

// The "delete the local branch after the worktree is gone" policy for
// the nuke-everything path (per-worktree deletes run the CLI's port):
// honor the global toggle, never touch externals (we didn't create the
// branch), skip placeholder branches, and swallow failures since the
// branch may be shared with another worktree or be the primary's HEAD.
// Leaving it behind is always the safe fallback.
export const deleteBranchAfterWorktreeRemovalEffect = Effect.fn(
  "branches.deleteBranchAfterWorktreeRemoval",
)(function* (
  projectPath: string,
  identity: WorktreeIdentity,
  enabled: boolean,
) {
  if (!enabled) return;
  if (identity.isExternal) return;
  if (!isRealBranch(identity.branch)) return;
  yield* Effect.ignore(
    deleteAnyLocalBranchEffect(projectPath, identity.branch, true),
  );
});

export function deleteBranchAfterWorktreeRemoval(
  projectPath: string,
  identity: WorktreeIdentity,
  enabled: boolean,
): Promise<void> {
  return runGit(
    deleteBranchAfterWorktreeRemovalEffect(projectPath, identity, enabled),
  );
}

// Create a local branch pointing at `base` (or HEAD if omitted). When
// base is a remote-tracking ref, `--track` sets upstream explicitly so
// the behavior doesn't depend on the user's branch.autoSetupMerge. A
// local base (even a slashed one like `feature/foo`) must not track,
// since that would pin the new branch's upstream to a local ref. An
// exact local branch wins over the remote interpretation, matching
// checkoutBranch's precedence.
export const createLocalBranchEffect = Effect.fn("branches.createLocalBranch")(
  function* (projectPath: string, name: string, base: string | undefined) {
    const track = base
      ? !(yield* localBranchExistsEffect(projectPath, base)) &&
        (yield* remoteRefExistsEffect(projectPath, base))
      : false;
    const args = ["branch"];
    if (track) args.push("--track");
    args.push("--", name);
    if (base) args.push(base);
    yield* runEffect(projectPath, args);
  },
);

export function createLocalBranch(
  projectPath: string,
  name: string,
  base: string | undefined,
): Promise<void> {
  return runGit(createLocalBranchEffect(projectPath, name, base));
}

// Rename any local branch (not necessarily the current one). `git branch
// -m <old> <new>` works even if `old` is checked out in a worktree. Git
// updates that worktree's HEAD to the new name.
export const renameAnyLocalBranchEffect = Effect.fn(
  "branches.renameAnyLocalBranch",
)(function* (projectPath: string, oldName: string, newName: string) {
  yield* runEffect(projectPath, ["branch", "-m", "--", oldName, newName]);
});

// Delete a local branch. Without `force` this is git's safe delete
// (`-d`), whose "not fully merged" refusal fails as BranchNotMerged so
// the renderer can offer a force retry. With `force` (`-D`), git still
// refuses if the branch is checked out in any worktree, which is the
// safety we care about.
export const deleteAnyLocalBranchEffect: (
  projectPath: string,
  name: string,
  force: boolean,
) => Effect.Effect<void, GitFailure | BranchNotMerged> = Effect.fn(
  "branches.deleteAnyLocalBranch",
)(function* (projectPath: string, name: string, force: boolean) {
  yield* runEffect(projectPath, [
    "branch",
    force ? "-D" : "-d",
    "--",
    name,
  ]).pipe(
    // git's stderr wording is stable here because core.ts pins LC_ALL=C.
    Effect.catchIf(
      (error) =>
        !force &&
        error._tag === "GitError" &&
        /not fully merged/.test(error.stderr),
      () => Effect.fail(branchNotMergedError(name)),
    ),
  );
});

export function deleteAnyLocalBranch(
  projectPath: string,
  name: string,
  force: boolean,
): Promise<void> {
  return runGit(deleteAnyLocalBranchEffect(projectPath, name, force));
}

// `--directory` collapses fully-ignored directories into a single
// trailing-slash entry; loose files inside partially-ignored dirs are
// listed individually. `-z` keeps non-ASCII names raw instead of
// core.quotePath-escaped so they compare equal against
// filesystem-derived paths.
function listOthersIgnoredEffect(
  projectPath: string,
  excludeArg: string,
): Effect.Effect<string[], GitFailure> {
  return runEffect(projectPath, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    excludeArg,
    "--directory",
  ]).pipe(Effect.map(splitZ));
}

// Untracked paths ignored by the standard excludes (.gitignore et al).
// The renderer derives membership from this list to decide whether a
// filesystem entry can be carried over.
export const listIgnoredPathsEffect = Effect.fn("branches.listIgnoredPaths")(
  function* (projectPath: string) {
    return yield* listOthersIgnoredEffect(projectPath, "--exclude-standard");
  },
);

export function listIgnoredPaths(projectPath: string): Promise<string[]> {
  return runGit(listIgnoredPathsEffect(projectPath));
}

// Untracked paths matched by the gitignore-syntax patterns in
// `excludeFile` (absolute path). `--exclude-from` replaces the standard
// excludes as the pattern source, so this evaluates ONLY the given file's
// patterns, with full gitignore semantics including negation.
export const listUntrackedMatchingExcludeFileEffect = Effect.fn(
  "branches.listUntrackedMatchingExcludeFile",
)(function* (projectPath: string, excludeFile: string) {
  return yield* listOthersIgnoredEffect(
    projectPath,
    `--exclude-from=${excludeFile}`,
  );
});

export function listUntrackedMatchingExcludeFile(
  projectPath: string,
  excludeFile: string,
): Promise<string[]> {
  return runGit(
    listUntrackedMatchingExcludeFileEffect(projectPath, excludeFile),
  );
}

// Lists branches usable as a base ref: local heads and remote-tracking refs.
// Symbolic refs like `origin/HEAD` are dropped because they alias another
// remote branch and would show up twice.
export const listBranchesEffect = Effect.fn("branches.listBranches")(function* (
  projectPath: string,
): Effect.fn.Return<BranchList, GitFailure> {
  const stdout = yield* runEffect(projectPath, [
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
});
