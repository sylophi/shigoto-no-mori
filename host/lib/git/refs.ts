// Ref and object plumbing for the pull orchestration and the mirror's
// git follower. Every argument that reaches argv here is either a
// schema-pinned hex hash / worktree id or an app-built refs/... path;
// --end-of-options pins them to the revision slot anyway, matching the
// house argv discipline (see captureDirtyState in cli/cmd_dirty.go).
import { Effect } from "effect";
import { runEffect, runGit } from "./core";

// The ref must not exist, in update-ref's compare-and-set vocabulary.
export const ZERO_SHA = "0".repeat(40);

export const updateRefEffect = Effect.fn("refs.updateRef")(function* (
  projectPath: string,
  ref: string,
  commit: string,
) {
  yield* runEffect(projectPath, [
    "update-ref",
    "--end-of-options",
    ref,
    commit,
  ]);
});

export function updateRef(
  projectPath: string,
  ref: string,
  commit: string,
): Promise<void> {
  return runGit(updateRefEffect(projectPath, ref, commit));
}

// Absence is fine: update-ref -d on a missing ref exits 0, so every
// error here is real.
export const deleteRefEffect = Effect.fn("refs.deleteRef")(function* (
  projectPath: string,
  ref: string,
) {
  yield* runEffect(projectPath, ["update-ref", "-d", "--end-of-options", ref]);
});

export function deleteRef(projectPath: string, ref: string): Promise<void> {
  return runGit(deleteRefEffect(projectPath, ref));
}

// The commit a ref resolves to, or null when it does not exist.
export const refTipEffect = Effect.fnUntraced(
  function* (cwd: string, ref: string) {
    const out = yield* runEffect(cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      ref,
    ]);
    const tip: string | null = out.trim();
    return tip;
  },
  Effect.orElseSucceed(() => null),
);

export function refTip(cwd: string, ref: string): Promise<string | null> {
  return runGit(refTipEffect(cwd, ref));
}

// Whether an object (any type, or a peeled form like `<sha>^{tree}`)
// exists in the repository.
export const hasObjectEffect = Effect.fnUntraced(
  function* (cwd: string, object: string) {
    yield* runEffect(cwd, ["cat-file", "-e", "--end-of-options", object]);
    return true;
  },
  Effect.orElseSucceed(() => false),
);

export function hasObject(cwd: string, object: string): Promise<boolean> {
  return runGit(hasObjectEffect(cwd, object));
}

export function hasCommitEffect(
  cwd: string,
  commit: string,
): Effect.Effect<boolean> {
  return hasObjectEffect(cwd, `${commit}^{commit}`);
}

export function hasCommit(cwd: string, commit: string): Promise<boolean> {
  return runGit(hasCommitEffect(cwd, commit));
}

export const treeOfEffect = Effect.fnUntraced(function* (
  cwd: string,
  commit: string,
) {
  const out = yield* runEffect(cwd, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${commit}^{tree}`,
  ]);
  return out.trim();
});

export function treeOf(cwd: string, commit: string): Promise<string> {
  return runGit(treeOfEffect(cwd, commit));
}

// merge-base --is-ancestor answers with the exit code: 0 yes, 1 no,
// anything else a real failure.
export const isAncestorEffect = Effect.fnUntraced(
  function* (cwd: string, ancestor: string, descendant: string) {
    yield* runEffect(cwd, [
      "merge-base",
      "--is-ancestor",
      "--end-of-options",
      ancestor,
      descendant,
    ]);
    return true;
  },
  Effect.catchIf(
    (error) => error._tag === "GitError" && error.exitCode === 1,
    () => Effect.succeed(false),
  ),
);

export function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  return runGit(isAncestorEffect(cwd, ancestor, descendant));
}

// Tips of every local branch, deduped, as `haves` for a thin bundle.
// Capped at the contract's 256-have limit; a repo with more branches
// just gets a slightly less thin bundle.
export const localBranchTipsEffect = Effect.fn("refs.localBranchTips")(
  function* (projectPath: string) {
    const stdout = yield* runEffect(projectPath, [
      "for-each-ref",
      "--format=%(objectname)",
      "refs/heads/",
    ]);
    return [...new Set(stdout.split("\n").filter(Boolean))].slice(0, 256);
  },
);

export function localBranchTips(projectPath: string): Promise<string[]> {
  return runGit(localBranchTipsEffect(projectPath));
}
