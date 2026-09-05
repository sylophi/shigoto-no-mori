import { FolderPlus, Inbox, ListTree } from "lucide-react";
import type { SidebarView } from "@shared/schemas";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/segmented-control";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { hasLocalHost } from "@/lib/localHost";
import {
  useSetSidebarView,
  useSidebarView,
} from "@/hooks/projects/useSidebarView";
import { useUpdater } from "@/hooks/system/useUpdater";
import { SidebarNavActions } from "./SidebarNavActions";
import { SIDEBAR_FOOTER_BAR, SIDEBAR_ICON_BUTTON } from "./sidebarChrome";
import { cn } from "@/lib/utils";

interface SidebarFooterProps {
  arrangeMode: boolean;
  onToggleArrange: () => void;
}

const VIEW_OPTIONS = [
  {
    value: "inbox",
    label: <Inbox aria-hidden className="size-3.5" />,
    title: "One list across every project, newest work first",
  },
  {
    value: "projects",
    label: <ListTree aria-hidden className="size-3.5" />,
    title: "Group worktrees by project",
  },
] as const satisfies ReadonlyArray<SegmentedOption<SidebarView>>;

// What both views share: the layout toggle, and the app-level actions.
// Anything that only answers a question the project tree asks lives in
// SidebarToolbar, above the tree. A hostless client has no local tree
// to lay out, arrange or add to, and no updater of its own, so its bar
// carries the page-nav cluster alone.
export function SidebarFooter(props: SidebarFooterProps) {
  return hasLocalHost ? <LocalFooter {...props} /> : <PeerFooter />;
}

function PeerFooter() {
  return (
    <div className={SIDEBAR_FOOTER_BAR}>
      <div className="flex-1" />
      <SidebarNavActions />
    </div>
  );
}

function LocalFooter({ arrangeMode, onToggleArrange }: SidebarFooterProps) {
  const { openAddProject } = useOverlays();
  const view = useSidebarView();
  const { mutate: setView } = useSetSidebarView();
  const { state: updaterState } = useUpdater();
  const updateReady = updaterState?.kind === "ready";
  // aria-keyshortcuts restores the AT-audible shortcut hints the old
  // native titles carried; Base UI tooltips are visual-only.
  const modName = "Meta";

  if (arrangeMode) {
    return (
      <div className={cn(SIDEBAR_FOOTER_BAR, "justify-end")}>
        <button
          type="button"
          onClick={onToggleArrange}
          className="rounded-md px-2 py-1 text-[11px] font-semibold tracking-wide text-foreground uppercase transition-colors hover:bg-accent"
        >
          Done arranging
        </button>
      </div>
    );
  }
  return (
    <div className={SIDEBAR_FOOTER_BAR}>
      <SegmentedControl<SidebarView>
        value={view}
        onChange={setView}
        options={VIEW_OPTIONS}
        aria-label="Sidebar layout"
        aria-keyshortcuts="Tab"
        optionClassName="px-1.5 py-1"
      />
      <div className="flex-1" />
      <SimpleTooltip tip="Add project (⌘N)">
        <button
          type="button"
          onClick={openAddProject}
          aria-label="Add project"
          aria-keyshortcuts={`${modName}+N`}
          className={SIDEBAR_ICON_BUTTON}
        >
          <FolderPlus className="size-3.5" />
        </button>
      </SimpleTooltip>
      <SidebarNavActions updateReady={updateReady} />
    </div>
  );
}
