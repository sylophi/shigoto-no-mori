import { hasLocalHost } from "@/lib/localHost";
import { SidebarNavActions } from "./SidebarNavActions";
import { SidebarViewToggle } from "./SidebarViewToggle";
import { SIDEBAR_FOOTER_BAR } from "./sidebarChrome";
import { cn } from "@/lib/utils";

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
  if (hasLocalHost && arrangeMode) {
    return (
      <div className={cn(SIDEBAR_FOOTER_BAR, "justify-end")}>
        <button
          type="button"
          onClick={onToggleArrange}
          className="rounded-md px-2 py-1 text-2xs font-semibold tracking-wide text-foreground uppercase transition-colors hover:bg-accent"
        >
          Done arranging
        </button>
      </div>
    );
  }
  return (
    <div className={SIDEBAR_FOOTER_BAR}>
      <SidebarViewToggle />
      <div className="flex-1" />
      <SidebarNavActions />
    </div>
  );
}
