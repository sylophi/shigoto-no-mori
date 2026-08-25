import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SidebarView } from "@shared/schemas";
import { isBareKeyEvent } from "@/lib/dom";
import { useOptimisticPreference } from "@/hooks/ui/useOptimisticPreference";
import { useHostScope } from "@/hooks/remote/useHostScope";

// Resolved, not the raw query: main already defaults a missing or
// unreadable preference to "projects", so the only gap left is the first
// paint before the read lands. Applying the same default here keeps that
// one literal in one place instead of at each call site.
export function useSidebarView(): SidebarView {
  const { api, keys } = useHostScope();
  const { data } = useQuery<SidebarView>({
    queryKey: keys.sidebarView(),
    queryFn: () => api.projects.getSidebarView(),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't read the sidebar layout" },
  });
  return data ?? "projects";
}

// Optimistic: the whole sidebar re-lays-out on this value, so waiting a
// round trip to redraw would read as a hang.
export function useSetSidebarView() {
  const { api, keys } = useHostScope();
  return useOptimisticPreference<SidebarView>(
    keys.sidebarView(),
    (view) => api.projects.setSidebarView(view),
    "Couldn't save the sidebar layout",
  );
}

// Tab flips the layout without reaching for the footer toggle. It lives
// here, with the read and the write, so the two-way flip sits next to
// the default it alternates around and doesn't depend on which
// component happens to paint the toggle.
//
// `enabled` is how the caller says the flip is meaningful right now.
// Arrange mode is a projects-tree affordance, so the tree can't be
// swapped out from under a drag.
//
// Worth knowing: this is a bare key, and preventDefault on Tab costs
// forward focus traversal for the whole window, not just the sidebar.
// Shift+Tab still walks backwards, and pointer focus is untouched.
export function useSidebarViewHotkey(enabled: boolean): void {
  const queryClient = useQueryClient();
  const { keys } = useHostScope();
  const { mutate: setView } = useSetSidebarView();

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !isBareKeyEvent(e)) return;
      e.preventDefault();
      // Read at press time rather than closing over the rendered value:
      // the optimistic write lands in the cache a microtask after the
      // press, but the rendered value only catches up a re-render
      // later, and that re-render rebuilds the whole sidebar row model.
      // Two quick presses off the stale value would write the same
      // layout twice and leave the sidebar one flip behind the keyboard.
      const view =
        queryClient.getQueryData<SidebarView>(keys.sidebarView()) ?? "projects";
      setView(view === "inbox" ? "projects" : "inbox");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, queryClient, setView, keys]);
}
