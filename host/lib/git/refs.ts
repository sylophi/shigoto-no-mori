// Plumbing over shigomori-owned refs (refs/shigomori/*) for the pull
// orchestration. Every argument that reaches argv here is either a
// schema-pinned hex hash / worktree id or an app-built refs/... path;
// --end-of-options pins them to the revision slot anyway, matching the
// house argv discipline (see captureDirtyState in cli/cmd_dirty.go).
import { run } from "./core";

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

export async function hasCommit(
  projectPath: string,
  commit: string,
): Promise<boolean> {
  try {
    await run(projectPath, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${commit}^{commit}`,
    ]);
    return true;
  } catch {
    return false;
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
