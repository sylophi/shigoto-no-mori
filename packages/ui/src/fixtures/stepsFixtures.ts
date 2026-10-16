// The v3 migration's states, as the host's view gives them with the
// window's sign-in beside them, for the scenes and the fake host's
// `?migration=` pose: six worktrees on the move, one of them locked and
// one a shell and a dev server work in.
import type {
  MigrationProgress,
  WorktreeMoveStep,
} from "@shigomori/contracts/schemas/migration";
import type { SignInStep } from "../views/steps/migrationEnded.ts";

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

const BUSY = {
  name: "brave-badger",
  reason: "close zsh (4123) and node (4410, 4411), which run in it",
};

const MOVED = { ...MOVE, state: "done", moved: 6, total: 6 } as const;

export const MIGRATION_POSES = {
  waiting: {
    migration: {
      planned: true,
      import: { state: "running" },
      worktrees: MOVE,
    },
    signIn: { state: "waiting", asks: false },
  },
  importStuck: {
    migration: {
      planned: true,
      import: {
        state: "stuck",
        reason:
          "~/.sm/registry.json could not be imported into the store. Fix the file or move it aside, then retry.\nRegistry: registry.json doesn't parse (Unexpected token '}' at position 312)",
      },
      worktrees: MOVE,
    },
    signIn: { state: "waiting", asks: false },
  },
  moving: {
    migration: {
      planned: true,
      import: { state: "done" },
      worktrees: {
        state: "running",
        moved: 3,
        total: 6,
        current: "happy-hummingbird",
        stuck: [],
      },
    },
    signIn: { state: "waiting", asks: false },
  },
  stuck: {
    migration: {
      planned: true,
      import: { state: "done" },
      worktrees: {
        state: "stuck",
        moved: 4,
        total: 6,
        current: null,
        stuck: [LOCKED, BUSY],
      },
    },
    signIn: { state: "done", asks: false },
  },
  signIn: {
    migration: { planned: true, import: { state: "done" }, worktrees: MOVED },
    signIn: { state: "waiting", asks: true },
  },
  done: {
    migration: { planned: true, import: { state: "done" }, worktrees: MOVED },
    signIn: { state: "done", asks: false },
  },
} satisfies Record<
  string,
  { migration: MigrationProgress; signIn: SignInStep | null }
>;

export type MigrationPose = keyof typeof MIGRATION_POSES;
