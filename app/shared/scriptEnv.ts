// Env vars injected into every user-written command: setup, teardown,
// `sm run` and custom tools (the engine's scriptEnv, Lifecycle.ts).
// Centralized so the app's own injection (host/lib/scripts) and the
// user-facing list (ScriptEnvPopover) can't drift apart.

export const SCRIPT_ENV_KEYS = {
  SCRIPT_NAME: "SHIGOMORI_SCRIPT_NAME",
  WORKTREE_PATH: "SHIGOMORI_WORKTREE_PATH",
  WORKTREE_NAME: "SHIGOMORI_WORKTREE_NAME",
  WORKTREE_BRANCH: "SHIGOMORI_WORKTREE_BRANCH",
  WORKTREE_ID: "SHIGOMORI_WORKTREE_ID",
  WORKTREE_TITLE: "SHIGOMORI_WORKTREE_TITLE",
  WORKTREE_DESCRIPTION: "SHIGOMORI_WORKTREE_DESCRIPTION",
  PROJECT_PATH: "SHIGOMORI_PROJECT_PATH",
  PROJECT_NAME: "SHIGOMORI_PROJECT_NAME",
  PROJECT_BRANCH: "SHIGOMORI_PROJECT_BRANCH",
  DEFAULT_BRANCH: "SHIGOMORI_DEFAULT_BRANCH",
} as const;

type ScriptEnvKey = (typeof SCRIPT_ENV_KEYS)[keyof typeof SCRIPT_ENV_KEYS];

export interface ScriptEnvDoc {
  name: ScriptEnvKey;
  desc: string;
}

export const SCRIPT_ENV_DOCS: ReadonlyArray<ScriptEnvDoc> = [
  {
    name: SCRIPT_ENV_KEYS.SCRIPT_NAME,
    desc: "setup, teardown, the package script's name, or the custom tool's label.",
  },
  {
    name: SCRIPT_ENV_KEYS.WORKTREE_PATH,
    desc: "Absolute path of the worktree.",
  },
  {
    name: SCRIPT_ENV_KEYS.WORKTREE_NAME,
    desc: "Folder name of the worktree.",
  },
  {
    name: SCRIPT_ENV_KEYS.WORKTREE_BRANCH,
    desc: "Branch checked out in the worktree.",
  },
  {
    name: SCRIPT_ENV_KEYS.WORKTREE_ID,
    desc: "Stable internal identifier.",
  },
  {
    name: SCRIPT_ENV_KEYS.WORKTREE_TITLE,
    desc: "Title set with sm describe, empty until one is. Not an open pull request's.",
  },
  {
    name: SCRIPT_ENV_KEYS.WORKTREE_DESCRIPTION,
    desc: "Description set with sm describe, as markdown.",
  },
  {
    name: SCRIPT_ENV_KEYS.PROJECT_PATH,
    desc: "Absolute path of the main checkout.",
  },
  {
    name: SCRIPT_ENV_KEYS.PROJECT_NAME,
    desc: "Project name.",
  },
  {
    name: SCRIPT_ENV_KEYS.PROJECT_BRANCH,
    desc: "Branch checked out in the main checkout.",
  },
  {
    name: SCRIPT_ENV_KEYS.DEFAULT_BRANCH,
    desc: "Configured default branch.",
  },
];
