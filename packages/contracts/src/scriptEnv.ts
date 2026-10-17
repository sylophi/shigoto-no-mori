// Env vars injected into every user-written command: setup, teardown,
// `sm run`, custom tools, and a worktree's terminal. Built here for the
// engine's lifecycle scripts (Lifecycle.ts) and the app's runs and
// terminals (host/lib/scripts) alike, and listed for the user
// (ScriptEnvPopover), so the three can't drift apart.

const SCRIPT_ENV_KEYS = {
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

// Where a command runs, which its SHIGOMORI_* values say.
export type ScriptEnvInput = {
  readonly worktree: {
    readonly path: string;
    readonly name: string;
    readonly branch: string;
    readonly id: string;
  };
  readonly project: { readonly path: string; readonly name: string };
  // The primary checkout's branch, empty for a bare repo.
  readonly projectBranch: string;
  // Empty when the default branch can't be resolved.
  readonly defaultBranch: string;
  // What `sm describe` set, empty when unset.
  readonly title: string;
  readonly description: string;
};

// The SHIGOMORI_* values, with SHIGOMORI_SCRIPT_NAME for a script (a
// terminal has none). exec refuses an environment holding a NUL, and
// the title and description are free text.
export const scriptEnvOf = (
  input: ScriptEnvInput,
  scriptName?: string,
): Partial<Record<ScriptEnvKey, string>> => {
  const values = {
    ...(scriptName === undefined
      ? {}
      : { [SCRIPT_ENV_KEYS.SCRIPT_NAME]: scriptName }),
    [SCRIPT_ENV_KEYS.WORKTREE_PATH]: input.worktree.path,
    [SCRIPT_ENV_KEYS.WORKTREE_NAME]: input.worktree.name,
    [SCRIPT_ENV_KEYS.WORKTREE_BRANCH]: input.worktree.branch,
    [SCRIPT_ENV_KEYS.WORKTREE_ID]: input.worktree.id,
    [SCRIPT_ENV_KEYS.WORKTREE_TITLE]: input.title,
    [SCRIPT_ENV_KEYS.WORKTREE_DESCRIPTION]: input.description,
    [SCRIPT_ENV_KEYS.PROJECT_PATH]: input.project.path,
    [SCRIPT_ENV_KEYS.PROJECT_NAME]: input.project.name,
    [SCRIPT_ENV_KEYS.PROJECT_BRANCH]: input.projectBranch,
    [SCRIPT_ENV_KEYS.DEFAULT_BRANCH]: input.defaultBranch,
  };
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value.replaceAll("\0", ""),
    ]),
  );
};

// What a script runs with when nobody is at it and its output goes to
// a pipe or the app's terminal: tools told it's a color terminal (a
// runner such as turbo or a `| tee` would otherwise go monochrome), and
// pagers off, so git and gh never wait in `less`.
export const UNATTENDED_ENV = {
  FORCE_COLOR: "1",
  TERM: "xterm-256color",
  PAGER: "cat",
  GIT_PAGER: "cat",
} as const;

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
    desc: "Title set with sm describe, empty until one is. Not a pull request's.",
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
