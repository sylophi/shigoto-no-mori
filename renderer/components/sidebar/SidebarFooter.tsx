import {
  FolderPlus,
  Inbox,
  ListTree,
  Settings as SettingsIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { SidebarView } from "@shared/schemas";
import { cn } from "@/lib/utils";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/segmented-control";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useOverlays } from "@/hooks/ui/useOverlays";
import {
  useSetSidebarView,
  useSidebarView,
} from "@/hooks/projects/useSidebarView";
import { useUpdater } from "@/hooks/system/useUpdater";
import { SIDEBAR_ICON_BUTTON } from "./sidebarChrome";

interface SidebarFooterProps {
  arrangeMode: boolean;
  onToggleArrange: () => void;
}

const VIEW_OPTIONS = [
  {
    value: "projects",
    label: <ListTree aria-hidden className="size-3.5" />,
    title: "Group worktrees by project",
  },
  {
    value: "inbox",
    label: <Inbox aria-hidden className="size-3.5" />,
    title: "One list across every project, newest work first",
  },
] as const satisfies ReadonlyArray<SegmentedOption<SidebarView>>;

// What both views share: the layout toggle, and the two app-level
// actions. Anything that only answers a question the project tree asks
// lives in SidebarToolbar, above the tree.
export function SidebarFooter({
  arrangeMode,
  onToggleArrange,
}: SidebarFooterProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { openAddProject } = useOverlays();
  const view = useSidebarView();
  const setView = useSetSidebarView();
  const { state: updaterState } = useUpdater();
  const updateReady = updaterState?.kind === "ready";
  const settingsActive = location.pathname === "/settings";
  // aria-keyshortcuts restores the AT-audible shortcut hints the old
  // native titles carried; Base UI tooltips are visual-only.
  const modName = "Meta";

  if (arrangeMode) {
    return (
      <div className="flex items-center justify-end border-t border-border px-2 py-1.5">
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
    <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
      <SegmentedControl<SidebarView>
        value={view}
        onChange={(next) => setView.mutate(next)}
        options={VIEW_OPTIONS}
        aria-label="Sidebar layout"
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
      <SimpleTooltip
        tip={updateReady ? "Settings — update available" : "Settings"}
      >
        <button
          type="button"
          onClick={() => void navigate({ to: "/settings" })}
          aria-label={updateReady ? "Settings (update available)" : "Settings"}
          aria-current={settingsActive ? "page" : undefined}
          className={cn(
            SIDEBAR_ICON_BUTTON,
            "relative",
            settingsActive && "bg-accent text-foreground",
          )}
        >
          <SettingsIcon className="size-3.5" />
          {updateReady && (
            <span
              aria-hidden
              className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-sky-500 ring-2 ring-card"
            />
          )}
        </button>
      </SimpleTooltip>
    </div>
  );
}
