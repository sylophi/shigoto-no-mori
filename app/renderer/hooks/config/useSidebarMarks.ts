import { clientSetting } from "@shigomori/contracts/schemas/config";
import type { SidebarMarks } from "@shigomori/ui/views/sidebar/WorktreeEntryView.tsx";
import { useHasLocalHost } from "@/lib/localHost";
import { useClientConfig } from "./useClientConfig";
import { useLocalGlobalConfig } from "./useGlobalConfig";

// One of this window's client config switches (Settings, Appearance),
// so it holds for every device's rows the window shows: the sidebar's
// marks among them. False until the config has loaded, so a mark
// switched off never flashes in.
//
// - markTerrierProjects: terrier's paw on the projects it lists. Off
//   unless switched on, and then shown only where terrierMarksHere
//   holds too.
// - allowAgentWorking: whether a worktree an agent session is working in
//   (`sm agents`) goes on its own shelf (isAgentWorking). Off unless
//   switched on.
// - markAgentsWaiting: the "Needs you" mark on a worktree whose agent
//   session waits on the user (AgentWaitingMark), its lead in the inbox
//   and the Live mark's amber. On unless switched off.
// - inlineWorktrees: whether the list of projects shows every project's
//   worktrees under it (buildSidebarRows' inline). Off unless switched
//   on.
// - widenForSideTerminals: whether terminals docked at the side widen
//   the window (TerminalDrawer). Off unless switched on.
type ClientFlag =
  | "markTerrierProjects"
  | "allowAgentWorking"
  | "markAgentsWaiting"
  | "inlineWorktrees"
  | "widenForSideTerminals";

export function useClientFlag(key: ClientFlag): boolean {
  const { data } = useClientConfig();
  return data !== undefined && clientSetting(data, key);
}

// Whether worktree rows and project headers wear the device badges
// (showDeviceIcons). Neither until the config has loaded, as a flag
// reads false.
export function useDeviceIcons(): { worktrees: boolean; projects: boolean } {
  const { data } = useClientConfig();
  const shown =
    data === undefined ? "none" : clientSetting(data, "showDeviceIcons");
  return { worktrees: shown !== "none", projects: shown === "all" };
}

// Whether Mark terrier projects can mark anything from this window,
// given this machine's terrier integration (`terrier`): only while it
// is on, since the Settings row locks and reads off without it
// (SidebarSection, which passes the staged value), and the paw must not
// go on marking a peer's projects behind that. A hostless client has no
// integration of its own and always can.
export function terrierMarksHere(
  hasLocalHost: boolean,
  terrier: boolean,
): boolean {
  return !hasLocalHost || terrier;
}

// terrierMarksHere over this machine's saved config, for the paw on
// the open project's header.
function useTerrierMarksHere(): boolean {
  const { data: config } = useLocalGlobalConfig();
  return terrierMarksHere(useHasLocalHost(), config?.terrier === true);
}

export function useSidebarMarks(): SidebarMarks {
  const markTerrier = useClientFlag("markTerrierProjects");
  const terrierHere = useTerrierMarksHere();
  const deviceIcons = useDeviceIcons();
  return {
    terrier: markTerrier && terrierHere,
    worktreeDevices: deviceIcons.worktrees,
    projectDevices: deviceIcons.projects,
    agentsWaiting: useClientFlag("markAgentsWaiting"),
  };
}
