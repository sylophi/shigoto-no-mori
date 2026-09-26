import { useQuery } from "@tanstack/react-query";
import type { ClientConfig } from "@shared/schemas";
import { hasLocalHost } from "@/lib/localHost";
import { clientConfigQueryOptions } from "./useClientConfig";
import { useLocalGlobalConfig } from "./useGlobalConfig";

// The sidebar's optional marks, read off this window's client config
// (Settings, Appearance), so they hold for every device's rows the
// window shows. Selected down to one flag each: every sidebar row reads
// them, and folding a project writes the same doc. False until the
// config has loaded, so a mark switched off never flashes in.
function useClientFlag(select: (config: ClientConfig) => boolean): boolean {
  const { data } = useQuery({
    ...clientConfigQueryOptions,
    select,
    meta: { errorTitle: "Couldn't load appearance settings" },
  });
  return data === true;
}

const markTerrierProjects = (config: ClientConfig) =>
  config.markTerrierProjects === true;
const showDeviceBadges = (config: ClientConfig) =>
  config.showDeviceBadges !== false;

// Terrier's paw on the projects it lists. Off unless switched on, and
// then shown only where terrierMarksHere holds too.
export function useMarkTerrierProjects(): boolean {
  return useClientFlag(markTerrierProjects);
}

// Whether Mark terrier projects can mark anything from this window,
// given this machine's terrier integration (`terrier`): only while it
// is on, since the Settings row locks and reads off without it
// (SidebarSection, which passes the staged value), and the paw must not
// go on marking a peer's projects behind that. A hostless client has no
// integration of its own and always can.
export function terrierMarksHere(terrier: boolean): boolean {
  return !hasLocalHost || terrier;
}

// terrierMarksHere over this machine's saved config, for the paw.
// Mounted only where a paw would show, so the rows that never wear one
// never read the device config.
export function useTerrierMarksHere(): boolean {
  const { data: config } = useLocalGlobalConfig();
  return terrierMarksHere(config?.terrier === true);
}

// The device badges on project headers and worktree rows. On unless
// switched off.
export function useShowDeviceBadges(): boolean {
  return useClientFlag(showDeviceBadges);
}
