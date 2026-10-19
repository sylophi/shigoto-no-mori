// What every test runner here applies to its own process before a test
// starts (the vitest configs, the app's proof runner, and the Go suites
// through testTemp.mts), so no test's git can reach this repository
// however it runs git.
//
// The pre-commit hook exports GIT_DIR and GIT_INDEX_FILE for the
// repository being committed. A test that inherited them ran its
// sandbox's git against the real repository (its config, its branch),
// three times: the third, a Go test's `git init`, set the shared
// config's core.bare under every worktree. So every GIT_* variable goes, and GIT_CEILING_DIRECTORIES
// stops git from finding the repository by walking up from a folder
// inside it. A git started at the repository's root still finds it,
// which the proof reading the tracked files (proof-selection) does on
// purpose.
import { spawnSync } from "node:child_process";

// The one place a test's git still finds this repository from.
export const repositoryRoot = import.meta.dirname;

// A variable of git's that came from outside: every GIT_* but the
// ceiling, which a test's own scrub must keep.
export const isOutsideGitVariable = (key: string): boolean =>
  key.startsWith("GIT_") && key !== "GIT_CEILING_DIRECTORIES";

export function isolateGit(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    if (isOutsideGitVariable(key)) delete env[key];
  }
  env.GIT_CEILING_DIRECTORIES = repositoryRoot;
}

// Fails unless this process is isolated: a GIT_* variable from outside
// is left, or a git started in `dir` finds the repository.
export function assertGitIsolated(dir: string): void {
  const left = Object.keys(process.env).filter(isOutsideGitVariable);
  if (left.length > 0) {
    throw new Error(`git's environment reached the tests: ${left.join(", ")}`);
  }
  assertRepositoryHidden(dir);
}

// Fails if a git started in `dir` (a folder inside the repository)
// finds the repository: what a test's own scrub must not undo.
export function assertRepositoryHidden(dir: string): void {
  const found = spawnSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (found.status === 0) {
    throw new Error(`a test's git found this repository: ${found.stdout}`);
  }
}
