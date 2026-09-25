// Ref and object plumbing for the pull orchestration and the mirror's
// git follower. Every argument that reaches argv here is either a
// schema-pinned hex hash / worktree id or an app-built refs/... path;
// --end-of-options pins them to the revision slot anyway, matching the
// house argv discipline (see captureDirtyState in cli/cmd_dirty.go).
import { run } from "./core";

// The ref must not exist, in update-ref's compare-and-set vocabulary.
export const ZERO_SHA = "0".repeat(40);

export async function updateRef(
  projectPath: string,
  ref: string,
  commit: string,
): Promise<void> {
  await run(projectPath, ["update-ref", "--end-of-options", ref, commit]);
}

// Absence is fine: update-ref -d on a missing ref exits 0, so every
// error here is real.
export async function deleteRef(
  projectPath: string,
  ref: string,
): Promise<void> {
  await run(projectPath, ["update-ref", "-d", "--end-of-options", ref]);
}

// The commit a ref resolves to, or null when it does not exist.
export async function refTip(cwd: string, ref: string): Promise<string | null> {
  try {
    const out = await run(cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      ref,
    ]);
    return out.trim();
  } catch {
    return null;
  }
}

// Whether an object (any type, or a peeled form like `<sha>^{tree}`)
// exists in the repository.
export async function hasObject(cwd: string, object: string): Promise<boolean> {
  try {
    await run(cwd, ["cat-file", "-e", "--end-of-options", object]);
    return true;
  } catch {
    return false;
  }
}

export function hasCommit(cwd: string, commit: string): Promise<boolean> {
  return hasObject(cwd, `${commit}^{commit}`);
}

export async function treeOf(cwd: string, commit: string): Promise<string> {
  const out = await run(cwd, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${commit}^{tree}`,
  ]);
  return out.trim();
}

// merge-base --is-ancestor answers with the exit code: 0 yes, 1 no,
// anything else a real failure.
export async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await run(cwd, [
      "merge-base",
      "--is-ancestor",
      "--end-of-options",
      ancestor,
      descendant,
    ]);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

// Tips of every local branch, deduped, as `haves` for a thin bundle.
// Capped at the contract's 256-have limit; a repo with more branches
// just gets a slightly less thin bundle.
export async function localBranchTips(projectPath: string): Promise<string[]> {
  const stdout = await run(projectPath, [
    "for-each-ref",
    "--format=%(objectname)",
    "refs/heads/",
  ]);
  return [...new Set(stdout.split("\n").filter(Boolean))].slice(0, 256);
}
