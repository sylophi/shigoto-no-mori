import { hasLocalHost } from "@/lib/localHost";
import { SidebarFooterView } from "./SidebarFooterView";
import { SidebarNavActions } from "./SidebarNavActions";
import { SidebarViewToggle } from "./SidebarViewToggle";

interface SidebarFooterProps {
  arrangeMode: boolean;
  onToggleArrange: () => void;
}

// What both views share: the layout toggle, and the app-level actions.
// Anything that only answers a question the project tree asks lives in
// SidebarToolbar, above the tree. A hostless client has no local tree
// to arrange or tidy, so its bar carries the toggle and the page-nav
// cluster.
export function SidebarFooter({
  arrangeMode,
  onToggleArrange,
}: SidebarFooterProps) {
  return (
    <SidebarFooterView
      onDoneArranging={
        hasLocalHost && arrangeMode ? onToggleArrange : undefined
      }
      toggle={<SidebarViewToggle />}
      actions={<SidebarNavActions />}
    />
  );
}
