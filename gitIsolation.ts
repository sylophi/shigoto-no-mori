// What every test runner here applies to its own process before a test
// starts (the vitest configs, the app's proof runner, the Go suites
// through testTemp.mts, the smoke, the scene comparison, the
// reliability harness and the guide's evaluation), so no test's git
// can reach this repository however it runs git.
//
// The pre-commit hook exports GIT_DIR and GIT_INDEX_FILE for the
// repository being committed. A test that inherited them ran its
// sandbox's git against the real repository (its config, its branch),
// three times: the third, a Go test's `git init`, set the shared
// config's core.bare under every worktree. So every GIT_* variable from
// outside goes, and GIT_CEILING_DIRECTORIES stops git from finding the
// repository by walking up from a folder inside it. A git started at
// the repository's root still finds it, which the proof reading the
// tracked files (proof-selection) does on purpose.
//
// Nor does a test's git read the machine's own config (its global and
// system files): a signing key there signed a fixture's commit with the
// owner's key, which can raise a password manager's prompt, and its
// hooks path, templates or aliases would run as well.
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

// The one place a test's git still finds this repository from.
export const repositoryRoot = import.meta.dirname;

// What isolation sets, which a test's own scrub must keep.
const ISOLATING = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
} as const;

// A variable of git's that came from outside: every GIT_* but the
// ceiling and the config isolation sets.
const isOutsideGitVariable = (key: string): boolean =>
  key.startsWith("GIT_") &&
  key !== "GIT_CEILING_DIRECTORIES" &&
  !(key in ISOLATING);

export function isolateGit(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    if (isOutsideGitVariable(key)) delete env[key];
  }
  env.GIT_CEILING_DIRECTORIES = repositoryRoot;
  Object.assign(env, ISOLATING);
}

// `env` isolated, as a copy, for a git given an environment of its own.
export function isolatedGitEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const copy = { ...env };
  isolateGit(copy);
  return copy;
}

// The identity a fixture's commits are made as, with no config to name one.
export const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "sm",
  GIT_AUTHOR_EMAIL: "sm@example.test",
  GIT_COMMITTER_NAME: "sm",
  GIT_COMMITTER_EMAIL: "sm@example.test",
} as const;

// Fails unless this process is isolated: a GIT_* variable from outside
// is left, or a git started in `dir` finds the repository.
export function assertGitIsolated(dir: string): void {
  const left = Object.keys(process.env).filter(isOutsideGitVariable);
  if (left.length > 0) {
    throw new Error(`git's environment reached the tests: ${left.join(", ")}`);
  }
  assertRepositoryHidden(dir);
  // Outside any repository, git reads config from nowhere at all.
  const config = spawnSync("git", ["config", "--list", "--show-origin"], {
    cwd: tmpdir(),
    encoding: "utf8",
  });
  if (config.stdout.trim() !== "") {
    throw new Error(
      `a test's git reads this machine's config:\n${config.stdout}`,
    );
  }
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
