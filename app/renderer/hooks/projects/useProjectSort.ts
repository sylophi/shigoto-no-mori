// How the sidebar and the launcher order this machine's projects. A
// preference of the window, kept in its client config like the sidebar
// view, so a peer has no say in it. Resolved, not the raw doc: an
// absent key reads as the manual order, in one place, and the manual
// order is stored as nothing. A hostless client never shows the sort
// menu, so it stays on the manual order: the tree it draws is the
// peers', which the merge orders.
import type { ProjectSortMode } from "@shared/schemas";
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
