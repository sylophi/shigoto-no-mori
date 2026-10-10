import { BranchNotMergedError } from "@shigomori/contracts/errors";
import type { BranchList } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import { run, splitZ } from "./core";
import {
  listRemotes,
  localBranchExists,
  remoteRefExists,
  splitRemoteRefSync,
} from "./remotes";

// Rename the branch currently checked out in a worktree.
// `git branch -m <new>` renames the current HEAD branch.
export const renameBranch = (worktreePath: string, newBranch: string) =>
  Effect.asVoid(run(worktreePath, ["branch", "-m", "--", newBranch]));

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
export const checkoutBranch = Effect.fnUntraced(function* (
  worktreePath: string,
  branch: string,
  remotes?: readonly string[],
) {
  // An exact local branch (including the rare literal "remote/thing") wins.
  if (yield* localBranchExists(worktreePath, branch)) {
    yield* run(worktreePath, ["checkout", "--end-of-options", branch, "--"]);
    return;
  }
  const split = splitRemoteRefSync(
    branch,
    remotes ?? (yield* listRemotes(worktreePath)),
  );
  // A qualified remote ref whose local branch doesn't exist yet: create the
  // tracking branch from the explicit ref so a name shared across remotes
  // stays unambiguous.
  if (split && !(yield* localBranchExists(worktreePath, split.branch))) {
    yield* run(worktreePath, [
      "checkout",
      "--track",
      "--end-of-options",
      branch,
      "--",
    ]);
    return;
  }
  // Either a plain name git can DWIM, or the stripped local branch already
  // exists, so switch to it.
  yield* run(worktreePath, [
    "checkout",
    "--end-of-options",
    split ? split.branch : branch,
    "--",
  ]);
});

// Create a local branch pointing at `base` (or HEAD if omitted). When
// base is a remote-tracking ref, `--track` sets upstream explicitly so
// the behavior doesn't depend on the user's branch.autoSetupMerge. A
// local base (even a slashed one like `feature/foo`) must not track,
// since that would pin the new branch's upstream to a local ref. An
// exact local branch wins over the remote interpretation, matching
// checkoutBranch's precedence.
export const createLocalBranch = Effect.fnUntraced(function* (
  projectPath: string,
  name: string,
  base: string | undefined,
) {
  const track = base
    ? !(yield* localBranchExists(projectPath, base)) &&
      (yield* remoteRefExists(projectPath, base))
    : false;
  const args = ["branch"];
  if (track) args.push("--track");
  args.push("--", name);
  if (base) args.push(base);
  yield* run(projectPath, args);
});

// Rename any local branch (not necessarily the current one). `git branch
// -m <old> <new>` works even if `old` is checked out in a worktree. Git
// updates that worktree's HEAD to the new name.
export const renameAnyLocalBranch = (
  projectPath: string,
  oldName: string,
  newName: string,
) => Effect.asVoid(run(projectPath, ["branch", "-m", "--", oldName, newName]));

// Delete a local branch. Without `force` this is git's safe delete
// (`-d`), whose "not fully merged" refusal is failed with the
// contract's BranchNotMergedError so the renderer can offer a force retry. With
// `force` (`-D`), git still refuses if the branch is checked out in any
// worktree, which is the safety we care about.
export const deleteAnyLocalBranch = (
  projectPath: string,
  name: string,
  force: boolean,
) =>
  run(projectPath, ["branch", force ? "-D" : "-d", "--", name]).pipe(
    Effect.asVoid,
    // git's stderr wording is stable here because core.ts pins LC_ALL=C.
    Effect.catchIf(
      (error) => !force && /not fully merged/.test(error.reason),
      () => Effect.fail(new BranchNotMergedError({ branch: name })),
    ),
  );

// `--directory` collapses fully-ignored directories into a single
// trailing-slash entry; loose files inside partially-ignored dirs are
// listed individually. `-z` keeps non-ASCII names raw instead of
// core.quotePath-escaped so they compare equal against
// filesystem-derived paths.
const listOthersIgnored = (projectPath: string, excludeArg: string) =>
  Effect.map(
    run(projectPath, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      excludeArg,
      "--directory",
    ]),
    splitZ,
  );

// Untracked paths ignored by the standard excludes (.gitignore et al).
// The renderer derives membership from this list to decide whether a
// filesystem entry can be carried over.
export const listIgnoredPaths = (projectPath: string) =>
  listOthersIgnored(projectPath, "--exclude-standard");

// Untracked paths matched by the gitignore-syntax patterns in
// `excludeFile` (absolute path). `--exclude-from` replaces the standard
// excludes as the pattern source, so this evaluates ONLY the given file's
// patterns, with full gitignore semantics including negation.
export const listUntrackedMatchingExcludeFile = (
  projectPath: string,
  excludeFile: string,
) => listOthersIgnored(projectPath, `--exclude-from=${excludeFile}`);

// Lists branches usable as a base ref: local heads and remote-tracking refs.
// Symbolic refs like `origin/HEAD` are dropped because they alias another
// remote branch and would show up twice.
export const listBranches = (projectPath: string) =>
  Effect.map(
    run(projectPath, [
      "for-each-ref",
      "--format=%(refname)\t%(refname:short)\t%(symref)",
      "refs/heads/",
      "refs/remotes/",
    ]),
    (stdout): BranchList => {
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
    },
  );
