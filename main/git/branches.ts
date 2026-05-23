import { type BranchList, isRealBranch } from "@shared/schemas";
import { Effect } from "effect";
import { Git, type GitService, runGitProgram } from "./core";
import type { WorktreeIdentity } from "./worktrees";

function runBranch<A>(
  effect: Effect.Effect<A, unknown, GitService>,
): Promise<A> {
  return runGitProgram(effect);
}

// Rename the branch currently checked out in a worktree.
// `git branch -m <new>` renames the current HEAD branch.
export async function renameBranch(
  worktreePath: string,
  newBranch: string,
): Promise<void> {
  return runBranch(Git.runVoid(worktreePath, ["branch", "-m", newBranch]));
}

// Switch a worktree to a different branch. For remote-tracking refs
// like `origin/foo`, git creates the local tracking branch automatically.
export async function checkoutBranch(
  worktreePath: string,
  branch: string,
): Promise<void> {
  return runBranch(Git.runVoid(worktreePath, ["checkout", branch]));
}

// Force-delete a local branch. Used after worktree removal when the
// global "deleteBranchOnRemove" setting is on. `git branch -D` refuses if
// the branch is checked out elsewhere, so safety against in-use branches
// is enforced by git itself.
export async function deleteLocalBranch(
  projectPath: string,
  branch: string,
): Promise<void> {
  return runBranch(Git.runVoid(projectPath, ["branch", "-D", branch]));
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
  return runBranch(
    Effect.gen(function* () {
      if (!enabled) return;
      if (identity.isExternal) return;
      if (!isRealBranch(identity.branch)) return;
      yield* Git.runVoid(projectPath, ["branch", "-D", identity.branch]).pipe(
        Effect.catchAll(() => Effect.void),
      );
    }),
  );
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
  return runBranch(Git.runVoid(projectPath, args));
}

// Rename any local branch (not necessarily the current one). `git branch
// -m <old> <new>` works even if `old` is checked out in a worktree —
// git updates that worktree's HEAD to the new name.
export async function renameAnyLocalBranch(
  projectPath: string,
  oldName: string,
  newName: string,
): Promise<void> {
  return runBranch(
    Git.runVoid(projectPath, ["branch", "-m", oldName, newName]),
  );
}

// Force-delete a local branch. Git still refuses if the branch is
// checked out in any worktree, which is the safety we care about.
export async function deleteAnyLocalBranch(
  projectPath: string,
  name: string,
): Promise<void> {
  return runBranch(Git.runVoid(projectPath, ["branch", "-D", name]));
}

// `--directory` collapses fully-ignored directories into a single
// trailing-slash entry; loose files inside partially-ignored dirs are
// listed individually. The renderer derives membership from this list to
// decide whether a filesystem entry can be carried over.
export async function listIgnoredPaths(projectPath: string): Promise<string[]> {
  return runBranch(
    Effect.gen(function* () {
      const stdout = yield* Git.run(projectPath, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
      ]);
      return stdout.split("\n").filter((line) => line.length > 0);
    }),
  );
}

// Lists branches usable as a base ref: local heads and remote-tracking refs.
// Symbolic refs like `origin/HEAD` are dropped — they alias another remote
// branch and would show up twice.
export async function listBranches(projectPath: string): Promise<BranchList> {
  return runBranch(
    Effect.gen(function* () {
      const stdout = yield* Git.run(projectPath, [
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
    }),
  );
}
