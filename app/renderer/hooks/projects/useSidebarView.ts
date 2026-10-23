import type { SidebarView } from "@shigomori/contracts/schemas";
import {
  clientConfigNow,
  useClientConfig,
} from "@/hooks/config/useClientConfig";
import { useClientConfigPatch } from "@/hooks/config/useClientConfigPatch";
import { useKeymapAction } from "@/hooks/ui/useKeymap";
import { useRegistry } from "@/lib/runtime/viewHooks";

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

// The keymap's sidebarLayout (Tab) flips the layout. It lives here,
// with the read and the write, so it doesn't depend on which component
// paints the toggle. The caller turns it off where a flip means
// nothing, and in arrange mode, so the tree isn't swapped out from under
// a drag. Tab is a bare key: taking it
// costs the whole window forward focus traversal, while Shift+Tab and
// pointer focus are untouched.
export function useSidebarViewHotkey(enabled: boolean): void {
  const registry = useRegistry();
  const { mutate: setView } = useSetSidebarView();

  useKeymapAction(
    "sidebarLayout",
    () => {
      // Read at press time: the rendered value catches up only a
      // re-render after the optimistic write, so two quick presses off
      // it would write the same layout twice.
      const view = clientConfigNow(registry)?.sidebarView ?? "projects";
      setView(view === "inbox" ? "projects" : "inbox");
    },
    { enabled },
  );
}
