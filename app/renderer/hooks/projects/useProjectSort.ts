// How the sidebar orders this machine's projects. A
// preference of the window, kept in its client config like the sidebar
// view, so a peer has no say in it. Resolved, not the raw doc: an
// absent key reads as the manual order, in one place, and the manual
// order is stored as nothing. A hostless client's menu offers no
// sort, so it stays on the manual order: the tree it draws is the
// peers', which the merge orders.
import {
  clientSetting,
  storedClientSetting,
} from "@shigomori/contracts/schemas/config";
import type { ProjectSortMode } from "@shigomori/contracts/schemas";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { useClientConfigPatch } from "@/hooks/config/useClientConfigPatch";

export function useProjectSort(): ProjectSortMode {
  const { data: config } = useClientConfig();
  return config?.projectsSort ?? "manual";
}

export function useSetProjectSort() {
  return useClientConfigPatch<ProjectSortMode>(
    (mode) => ({ projectsSort: mode === "manual" ? undefined : mode }),
    "Couldn't save project sort preference",
  );
}

// Whether the list of projects is split under a header per owner
// (buildSidebarRows), kept beside the sort.
export function useGroupProjectsByOwner(): boolean {
  const { data: config } = useClientConfig();
  return clientSetting(config ?? {}, "groupProjectsByOwner");
}

export function useSetGroupProjectsByOwner() {
  return useClientConfigPatch<boolean>(
    (on) => ({
      groupProjectsByOwner: storedClientSetting("groupProjectsByOwner", on),
    }),
    "Couldn't save project grouping preference",
  );
}
