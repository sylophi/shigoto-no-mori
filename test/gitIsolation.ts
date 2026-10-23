// What every test runner here applies to its own process before a test
// starts (the vitest configs, the Go tests through testTemp.mts, the
// smoke, the scene comparison, the reliability harness and the guide's
// evaluation), so no test's git can reach this repository however it
// runs git.
//
// The pre-commit hook exports GIT_DIR and GIT_INDEX_FILE for the
// repository being committed. A test that inherited them would run its
// sandbox's git against the real repository (its config, its branch):
// a `git init` there sets the shared config's core.bare under every
// worktree. So every GIT_* variable from outside goes, and
// GIT_CEILING_DIRECTORIES stops git from finding the repository by
// walking up from a folder inside it.
//
// Nor does a test's git read the machine's own config (its global and
// system files): a signing key there would sign a fixture's commit
// with the owner's key, which can raise a password manager's prompt,
// and its hooks path, templates or aliases would run as well.
import { dirname } from "node:path";

// The one place a test's git still finds this repository from.
export const repositoryRoot = dirname(import.meta.dirname);

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
