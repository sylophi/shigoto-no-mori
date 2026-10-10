import { launchersContract } from "@shigomori/contracts/modules/launchers";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import * as Effect from "effect/Effect";
import type * as Engine from "@host/lib/engine";
import * as Ops from "@host/lib/engineOps";
import { findProject } from "@host/lib/projects";

// The launcher row is the engine's: the tool catalog, what is installed,
// the GitHub entry, custom commands, the hidden filter and the
// rolling-window use order all come from `sm launchers`, and a launch
// is `sm open`, which counts the use in the same use log a
// terminal launch bumps. So the row orders the same wherever a tool was
// last opened from.
export const launchersHandlers = {
  // Every catalog tool with whether it is installed, for Settings.
  detect: () => Ops.launcherCatalog(),

  // Authoritative ordering used by both the LauncherRow buttons and the
  // File menu ⌘1..⌘9 entries: most used within the window first, label
  // as the tiebreaker. The renderer query has a staleTime and useLaunch
  // doesn't invalidate it, so the visible order stays put while the
  // user interacts.
  forProject: ({ projectId }) => Ops.launcherRow(projectId),

  // Hiding is presentational only: `sm open` still resolves a hidden
  // id, so an in-flight deep link or a stale menu accelerator keeps
  // working.
  launch: ({ projectId, worktreeId, launcherId }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      Ops.openLauncher(project, worktreeId, launcherId),
    ),
} satisfies EffectHandlers<typeof launchersContract, unknown, Engine.Services>;
