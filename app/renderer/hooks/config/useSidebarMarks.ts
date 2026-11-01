import { clientSetting } from "@shigomori/contracts/schemas/config";
import type { SidebarMarks } from "@shigomori/ui/views/sidebar/WorktreeEntryView.tsx";
import type { ClientConfig } from "@shigomori/contracts/schemas";
import { useHasLocalHost } from "@/lib/localHost";
import { useClientConfig } from "./useClientConfig";
import { useLocalGlobalConfig } from "./useGlobalConfig";

// One of this window's client config switches (Settings, Appearance),
// so it holds for every device's rows the window shows: the sidebar's
// marks among them. False until the config has loaded, so a mark
// switched off never flashes in.
type ClientFlag = {
  [K in keyof ClientConfig]-?: NonNullable<ClientConfig[K]> extends boolean
    ? K
    : never;
}[keyof ClientConfig];

export function useClientFlag(key: ClientFlag): boolean {
  const { data } = useClientConfig();
  return data !== undefined && clientSetting(data, key);
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
  return {
    terrier: markTerrier && terrierHere,
    deviceBadges: useClientFlag("showDeviceBadges"),
    agentsWaiting: useClientFlag("markAgentsWaiting"),
    allowAgentWorking: useClientFlag("allowAgentWorking"),
  };
}
