// Env vars injected into setup/teardown script processes. Centralized so
// the main-side injection in scripts.ts and the user-facing list in
// ConfigureProject can't drift apart.

export const SCRIPT_ENV_KEYS = {
  SCRIPT_NAME: "SHIGOMORI_SCRIPT_NAME",
  WORKTREE_PATH: "SHIGOMORI_WORKTREE_PATH",
  WORKTREE_NAME: "SHIGOMORI_WORKTREE_NAME",
  WORKTREE_BRANCH: "SHIGOMORI_WORKTREE_BRANCH",
  WORKTREE_ID: "SHIGOMORI_WORKTREE_ID",
  PROJECT_PATH: "SHIGOMORI_PROJECT_PATH",
  PROJECT_NAME: "SHIGOMORI_PROJECT_NAME",
  PROJECT_BRANCH: "SHIGOMORI_PROJECT_BRANCH",
  DEFAULT_BRANCH: "SHIGOMORI_DEFAULT_BRANCH",
} as const;

export type ScriptEnvKey =
  (typeof SCRIPT_ENV_KEYS)[keyof typeof SCRIPT_ENV_KEYS];

export interface ScriptEnvDoc {
  name: ScriptEnvKey;
  desc: string;
}

export const SCRIPT_ENV_DOCS: ReadonlyArray<ScriptEnvDoc> = [
  {
    name: SCRIPT_ENV_KEYS.SCRIPT_NAME,
    desc: "setup or teardown.",
  },
  {
    name: SCRIPT_ENV_KEYS.WORKTREE_PATH,
    desc: "absolute path of the worktree.",
  },
  {
    name: SCRIPT_ENV_KEYS.WORKTREE_NAME,
    desc: "dirname of the worktree.",
  },
  {
    name: SCRIPT_ENV_KEYS.WORKTREE_BRANCH,
    desc: "branch currently checked out here.",
  },
  {
    name: SCRIPT_ENV_KEYS.WORKTREE_ID,
    desc: "stable internal identifier.",
  },
  {
    name: SCRIPT_ENV_KEYS.PROJECT_PATH,
    desc: "absolute path of the main checkout.",
  },
  {
    name: SCRIPT_ENV_KEYS.PROJECT_NAME,
    desc: "project name.",
  },
  {
    name: SCRIPT_ENV_KEYS.PROJECT_BRANCH,
    desc: "branch checked out at the main checkout.",
  },
  {
    name: SCRIPT_ENV_KEYS.DEFAULT_BRANCH,
    desc: "configured default branch.",
  },
];
