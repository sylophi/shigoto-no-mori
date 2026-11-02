import { launchersContract } from "@shigomori/contracts/modules/launchers";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import type * as Engine from "@host/lib/Engine";
import { findProject, findProjectAndWorktree } from "@host/lib/projects";
import * as Launchers from "@shigomori/engine/Launchers";
import * as Open from "@shigomori/engine/Open";
import { inAppTerminal } from "@host/lib/terminals/inAppTerminal";
import type { Terminals } from "@host/lib/terminals/Terminals";

// The launcher row is the engine's: the tool catalog, what is installed,
// the GitHub entry, custom commands, the hidden filter and the
// rolling-window use order all come from `sm launchers`, and a launch
// is `sm open`, which counts the use in the same use log a
// terminal launch bumps. So the row orders the same wherever a tool was
// last opened from.
export const launchersHandlers = {
  // Every catalog tool with whether it is installed, for Settings.
  detect: () =>
    Effect.flatMap(Launchers.Launchers, (launchers) => launchers.catalog),

  // Authoritative ordering used by both the LauncherRow buttons and the
  // File menu ⌘1..⌘9 entries: most used within the window first, label
  // as the tiebreaker. The renderer query has a staleTime and useLaunch
  // doesn't invalidate it, so the visible order stays put while the
  // user interacts.
  forProject: ({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      const { entries, hiddenCount } = yield* (yield* Launchers.Launchers).row(
        project,
      );
      return { entries, hiddenCount };
    }),

  // Hiding is presentational only: `sm open` still resolves a hidden
  // id, so an in-flight deep link or a stale menu accelerator keeps
  // working.
  launch: ({ projectId, worktreeId, launcherId }) =>
    inAppTerminal(
      Effect.gen(function* () {
        const located = yield* findProjectAndWorktree(projectId, worktreeId);
        yield* (yield* Open.Open).open(located, launcherId);
      }),
    ),

  // `sm worktrees edit`'s Open.edit: the editor setting, or the file's
  // default app.
  openFile: ({ projectId, worktreeId, path }) =>
    inAppTerminal(
      Effect.gen(function* () {
        const located = yield* findProjectAndWorktree(projectId, worktreeId);
        yield* (yield* Open.Open).edit(located, path);
      }),
    ),
} satisfies EffectHandlers<
  typeof launchersContract,
  unknown,
  Engine.Services | Terminals
>;
