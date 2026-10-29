import { clientSetting } from "@shigomori/contracts/schemas/config";
import type { SidebarMarks } from "@shigomori/ui/views/sidebar/WorktreeEntryView.tsx";
import type { ClientConfig } from "@shigomori/contracts/schemas";
import { useHasLocalHost } from "@/lib/localHost";
import { useClientConfig } from "./useClientConfig";
import { useLocalGlobalConfig } from "./useGlobalConfig";

// The sidebar's optional marks, read off this window's client config
// (Settings, Appearance), so they hold for every device's rows the
// window shows. Selected down to one flag each: the sidebar's rows read
// them, and folding a project writes the same doc. False until the
// config has loaded, so a mark switched off never flashes in.
function useClientFlag(select: (config: ClientConfig) => boolean): boolean {
  const { data } = useClientConfig();
  return data !== undefined && select(data);
}

const markTerrierProjects = (config: ClientConfig) =>
  clientSetting(config, "markTerrierProjects");
const showDeviceBadges = (config: ClientConfig) =>
  clientSetting(config, "showDeviceBadges");
const allowAgentWorking = (config: ClientConfig) =>
  clientSetting(config, "allowAgentWorking");
const markAgentsWaiting = (config: ClientConfig) =>
  clientSetting(config, "markAgentsWaiting");
const inlineWorktrees = (config: ClientConfig) =>
  clientSetting(config, "inlineWorktrees");

// Terrier's paw on the projects it lists. Off unless switched on, and
// then shown only where terrierMarksHere holds too.
function useMarkTerrierProjects(): boolean {
  return useClientFlag(markTerrierProjects);
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

// The device badges on project headers and worktree rows. On unless
// switched off.
export function useShowDeviceBadges(): boolean {
  return useClientFlag(showDeviceBadges);
}

// Whether a worktree an agent session is working in (`sm agents`) goes
// on its own shelf (isAgentWorking). Off unless switched on.
export function useAllowAgentWorking(): boolean {
  return useClientFlag(allowAgentWorking);
}

// The "Needs you" mark on a worktree whose agent session waits on the
// user (AgentWaitingMark), its lead in the inbox and the Live mark's
// amber. On unless switched off.
export function useMarkAgentsWaiting(): boolean {
  return useClientFlag(markAgentsWaiting);
}

// Whether the list of projects shows every project's worktrees under it
// (buildSidebarRows' inline). Off unless switched on.
export function useInlineWorktrees(): boolean {
  return useClientFlag(inlineWorktrees);
}

export function useSidebarMarks(): SidebarMarks {
  const markTerrier = useMarkTerrierProjects();
  const terrierHere = useTerrierMarksHere();
  return {
    terrier: markTerrier && terrierHere,
    deviceBadges: useShowDeviceBadges(),
    agentsWaiting: useMarkAgentsWaiting(),
    allowAgentWorking: useAllowAgentWorking(),
  };
}
