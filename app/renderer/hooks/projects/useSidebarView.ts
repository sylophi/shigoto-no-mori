import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ClientConfig, SidebarView } from "@shigomori/contracts/schemas";
import { isBareKeyEvent } from "@/lib/dom";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { useClientConfigPatch } from "@/hooks/config/useClientConfigPatch";
import { queryKeys } from "@/lib/queryKeys";

// Which layout the sidebar shows. A preference of the window showing
// it, kept in the client config like the theme, so a hostless client
// has one exactly as the desktop does. Resolved, not the raw doc: an
// absent key reads as the classic tree, in one place.
export function useSidebarView(): SidebarView {
  const { data: config } = useClientConfig();
  return config?.sidebarView ?? "projects";
}

// Whether the view above is the saved one yet rather than the default
// standing in for it while the config loads.
export function useSidebarViewSettled(): boolean {
  return !useClientConfig().isPending;
}

// Optimistic through the patch hook: the whole sidebar re-lays-out on
// this value, so waiting a round trip to redraw would read as a hang.
export function useSetSidebarView() {
  return useClientConfigPatch<SidebarView>(
    (view) => ({ sidebarView: view }),
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
        queryClient.getQueryData<ClientConfig>(queryKeys.clientConfig())
          ?.sidebarView ?? "projects";
      setView(view === "inbox" ? "projects" : "inbox");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setView is a fresh closure per render, and the handler only reads the cache, so re-subscribing each render would be churn.
  }, [enabled, queryClient]);
}
