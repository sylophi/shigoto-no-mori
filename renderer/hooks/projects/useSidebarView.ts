import { useQuery } from "@tanstack/react-query";
import type { SidebarView } from "@shared/schemas";
import { useOptimisticPreference } from "@/hooks/ui/useOptimisticPreference";
import { queryKeys } from "@/lib/queryKeys";

// Resolved, not the raw query: main already defaults a missing or
// unreadable preference to "projects", so the only gap left is the first
// paint before the read lands. Applying the same default here keeps that
// one literal in one place instead of at each call site.
export function useSidebarView(): SidebarView {
  const { data } = useQuery<SidebarView>({
    queryKey: queryKeys.sidebarView(),
    queryFn: () => window.api.projects.getSidebarView(),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't read the sidebar layout" },
  });
  return data ?? "projects";
}

// Optimistic: the whole sidebar re-lays-out on this value, so waiting a
// round trip to redraw would read as a hang.
export function useSetSidebarView() {
  return useOptimisticPreference<SidebarView>(
    queryKeys.sidebarView(),
    (view) => window.api.projects.setSidebarView(view),
    "Couldn't save the sidebar layout",
  );
}
