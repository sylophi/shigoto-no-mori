import { launchersContract } from "@shared/ipc/modules/launchers";
import type { Handlers } from "@shared/ipc/types";
import { findProjectOrThrow } from "@host/lib/projects";
import {
  launcherCatalogViaCli,
  launchersViaCli,
  openLauncherViaCli,
} from "../cliDelegate";

// The launcher row is the CLI's: the tool catalog, what is installed,
// the GitHub entry, custom commands, the hidden filter and the
// rolling-window use order all come from `sm launchers`, and a launch
// is `sm open`, which counts the use in the same state.json log a
// terminal launch bumps. So the row orders the same wherever a tool was
// last opened from.
export const launchersHandlers: Handlers<typeof launchersContract> = {
  // Every catalog tool with whether it is installed, for Settings.
  detect: () => launcherCatalogViaCli(),

  // Authoritative ordering used by both the LauncherRow buttons and the
  // File menu ⌘1..⌘9 entries: most used within the window first, label
  // as the tiebreaker. The renderer query has a staleTime and useLaunch
  // doesn't invalidate it, so the visible order stays put while the
  // user interacts.
  forProject: ({ projectId }) => launchersViaCli(projectId),

  // Hiding is presentational only: `sm open` still resolves a hidden
  // id, so an in-flight deep link or a stale menu accelerator keeps
  // working.
  launch: async ({ projectId, worktreeId, launcherId }) =>
    openLauncherViaCli(
      await findProjectOrThrow(projectId),
      worktreeId,
      launcherId,
    ),
};
