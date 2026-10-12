// What every test runner here applies to its own process before a test
// starts (the app's, the engine's and the terminal's vitest configs,
// and the app's proof runner), so no test's git can reach this
// repository however it runs git.
//
// The pre-commit hook exports GIT_DIR and GIT_INDEX_FILE for the
// repository being committed. A test that inherited them ran its
// sandbox's git against the real repository (its config, its branch),
// twice. So every GIT_* variable goes, and GIT_CEILING_DIRECTORIES
// stops git from finding the repository by walking up from a folder
// inside it. A git started at the repository's root still finds it,
// which the proof reading the tracked files (proof-selection) does on
// purpose.
import { spawnSync } from "node:child_process";

const repositoryRoot = import.meta.dirname;

export function isolateGit(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_CEILING_DIRECTORIES = repositoryRoot;
}

// Fails unless this process is isolated: a GIT_* variable from outside
// is left, or a git started in `dir` (a folder inside the repository)
// finds the repository. Each runner's tests call it once.
export function assertGitIsolated(dir: string): void {
  const left = Object.keys(process.env).filter(
    (key) => key.startsWith("GIT_") && key !== "GIT_CEILING_DIRECTORIES",
  );
  if (left.length > 0) {
    throw new Error(`git's environment reached the tests: ${left.join(", ")}`);
  }
  const found = spawnSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (found.status === 0) {
    throw new Error(`a test's git found this repository: ${found.stdout}`);
  }
}
