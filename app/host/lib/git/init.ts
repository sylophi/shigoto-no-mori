import { mkdir, rm } from "node:fs/promises";
import { checkNewCheckoutDestination } from "./clone";
import { run, runLenient } from "./core";

// Starts a repository at `parentDir/name` and returns its path. It gets
// an empty first commit: a worktree branches off the default branch,
// and an unborn one has nothing to branch off.
export async function createRepo(
  parentDir: string,
  name: string,
): Promise<string> {
  const dest = await checkNewCheckoutDestination(parentDir, name);
  await mkdir(dest);
  try {
    // git's own default is still master. Unless the user configured
    // theirs, a new repo starts on main, as one made on GitHub does.
    const configured = (
      await runLenient(dest, ["config", "--get", "init.defaultBranch"])
    ).trim();
    await run(dest, ["init", `--initial-branch=${configured || "main"}`]);
    await run(dest, ["commit", "--allow-empty", "-m", "Initial commit"]);
  } catch (error) {
    // The folder holds only what was just made, so a failed start
    // leaves nothing behind and a retry finds the name free (a commit
    // with no git identity set is the likely failure).
    await rm(dest, { recursive: true, force: true });
    throw error;
  }
  return dest;
}
