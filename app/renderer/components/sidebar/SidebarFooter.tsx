import { FolderPlus } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { hasLocalHost } from "@/lib/localHost";
import { SidebarNavActions } from "./SidebarNavActions";
import { SidebarViewToggle } from "./SidebarViewToggle";
import { SIDEBAR_FOOTER_BAR, SIDEBAR_ICON_BUTTON } from "./sidebarChrome";
import { cn } from "@/lib/utils";

interface SidebarFooterProps {
  arrangeMode: boolean;
  onToggleArrange: () => void;
}

// What both views share: the layout toggle, and the app-level actions.
// Anything that only answers a question the project tree asks lives in
// SidebarToolbar, above the tree. A hostless client has no local tree
// to arrange, so its bar carries the toggle, add project (onto one of
// its peers) and the page-nav cluster.
export function SidebarFooter(props: SidebarFooterProps) {
  return hasLocalHost ? <LocalFooter {...props} /> : <PeerFooter />;
}

function PeerFooter() {
  return (
    <div className={SIDEBAR_FOOTER_BAR}>
      <SidebarViewToggle />
      <div className="flex-1" />
      <AddProjectButton />
      <SidebarNavActions />
    </div>
  );
}

// ⌘N is a native menu accelerator, so only the desktop app has it.
function AddProjectButton() {
  const { openAddProject } = useOverlays();
  // aria-keyshortcuts restores the AT-audible shortcut hints the old
  // native titles carried; Base UI tooltips are visual-only.
  const modName = "Meta";
  return (
    <SimpleTooltip tip={hasLocalHost ? "Add project (⌘N)" : "Add project"}>
      <button
        type="button"
        onClick={() => openAddProject()}
        aria-label="Add project"
        aria-keyshortcuts={hasLocalHost ? `${modName}+N` : undefined}
        className={SIDEBAR_ICON_BUTTON}
      >
        <FolderPlus className="size-3.5" />
      </button>
    </SimpleTooltip>
  );
}

function LocalFooter({ arrangeMode, onToggleArrange }: SidebarFooterProps) {
  if (arrangeMode) {
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
      <AddProjectButton />
      <SidebarNavActions />
    </div>
  );
}
