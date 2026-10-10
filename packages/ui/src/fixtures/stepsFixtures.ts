// The v3 migration's states, as the host's view gives them, for the
// scenes and the fake host's `?migration=` pose: six worktrees on the
// move, one of them locked.
import type {
  Migration,
  WorktreeMoveStep,
} from "@shigomori/contracts/schemas/migration";

const MOVE: WorktreeMoveStep = {
  state: "waiting",
  moved: 0,
  total: 0,
  current: null,
  stuck: [],
};

const LOCKED = {
  name: "gentle-gecko",
  reason: "cannot move a locked working tree",
};

export const MIGRATION_POSES = {
  waiting: {
    planned: true,
    import: { state: "running" },
    worktrees: MOVE,
    signIn: { state: "waiting", lapsed: false },
  },
  moving: {
    planned: true,
    import: { state: "done" },
    worktrees: {
      state: "running",
      moved: 3,
      total: 6,
      current: "happy-hummingbird",
      stuck: [],
    },
    signIn: { state: "waiting", lapsed: false },
  },
  stuck: {
    planned: true,
    import: { state: "done" },
    worktrees: {
      state: "stuck",
      moved: 5,
      total: 6,
      current: null,
      stuck: [LOCKED],
    },
    signIn: { state: "done", lapsed: false },
  },
  signIn: {
    planned: true,
    import: { state: "done" },
    worktrees: { ...MOVE, state: "done", moved: 6, total: 6 },
    signIn: { state: "waiting", lapsed: true },
  },
  done: {
    planned: true,
    import: { state: "done" },
    worktrees: { ...MOVE, state: "done", moved: 6, total: 6 },
    signIn: { state: "done", lapsed: false },
  },
} satisfies Record<string, Migration>;

export type MigrationPose = keyof typeof MIGRATION_POSES;

// terrier's repos, for the first run's project step.
export const TERRIER_REPOS = [
  { name: "dotfiles", path: "~/dev/dotfiles" },
  { name: "kawaii-cam", path: "~/dev/kawaii-cam" },
  { name: "shigoto-no-mori", path: "~/dev/shigoto-no-mori" },
];
