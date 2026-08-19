import { useState } from "react";
import { ArrowUpDown, Check, LayoutGrid, Trees } from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { ProjectSortMode } from "@shared/schemas";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  useProjectSort,
  useSetProjectSort,
} from "@/hooks/projects/useProjectSort";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { SIDEBAR_ICON_BUTTON } from "./sidebarChrome";

interface SidebarToolbarProps {
  // Enter-only: the footer owns "Done arranging", so this never toggles
  // back out.
  onArrange: () => void;
}

const SORT_OPTIONS: ReadonlyArray<{ value: ProjectSortMode; label: string }> = [
  { value: "alphabetical", label: "Alphabetical" },
  { value: "recent", label: "Most recently used" },
  { value: "frequent", label: "Most used" },
  { value: "manual", label: "Manual order" },
];

// Controls that only mean something to the project tree: ordering the
// projects, and hopping between them. Neither has an answer in the inbox
// -- it's one list in one fixed order -- so they live above the tree
// rather than in the footer, where they'd have to blink in and out as
// the view changes. The footer keeps what both views share.
export function SidebarToolbar({ onArrange }: SidebarToolbarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { toggleLauncher } = useOverlays();
  const tidyActive = location.pathname === "/tidy";
  const { data: sortMode = "manual" } = useProjectSort();
  const setSortMode = useSetProjectSort();
  const [sortMenuOpen, setSortMenuOpen] = useState(false);

  // Dragging only reorders coherently when the displayed order matches the
  // stored order, so arranging forces the manual sort before entering the
  // drag view.
  const arrangeManually = () => {
    setSortMode.mutate("manual");
    onArrange();
  };

  return (
    // Same left/right split as the footer below it: the control that
    // changes how the list reads sits left, the one that navigates away
    // sits right.
    <div className="flex items-center gap-1 px-2 pb-1">
      <DropdownMenu open={sortMenuOpen} onOpenChange={setSortMenuOpen}>
        {/* The tooltip hangs on a wrapper span, not the trigger button:
            merged onto the button, the tooltip's attributes would
            overwrite data-slot="dropdown-menu-trigger" and put
            data-popup-open next to aria-haspopup, which doubutsu
            styles as "menu open". Disabled while the menu is open so
            the tip can't cover the popup. */}
        <SimpleTooltip tip="Sort projects" disabled={sortMenuOpen}>
          <span className="inline-flex">
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Sort projects"
                  className={SIDEBAR_ICON_BUTTON}
                >
                  <ArrowUpDown className="size-3.5" />
                </button>
              }
            />
          </span>
        </SimpleTooltip>
        {/* Anchored under the trigger now that it sits at the top of the
            sidebar rather than the bottom. */}
        <DropdownMenuContent align="end" side="bottom" sideOffset={2}>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            {SORT_OPTIONS.map((option) => (
              <DropdownMenuItem
                key={option.value}
                onClick={() => setSortMode.mutate(option.value)}
              >
                <Check
                  className={cn(
                    "size-3.5",
                    sortMode === option.value ? "opacity-100" : "opacity-0",
                  )}
                />
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={arrangeManually}>
            Set manual order
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="flex-1" />
      {/* The tidy page spans every project, which is the same span this
          view has -- so it sits with the controls that leave the tree
          rather than in the footer. Settings keeps the explained entry
          for anyone reading the inbox, which has no toolbar. */}
      <SimpleTooltip tip="Tidy the forest — sizes, staleness, what has landed">
        <button
          type="button"
          onClick={() => void navigate({ to: "/tidy" })}
          aria-label="Tidy the forest"
          aria-current={tidyActive ? "page" : undefined}
          className={cn(
            SIDEBAR_ICON_BUTTON,
            tidyActive && "bg-accent text-foreground",
          )}
        >
          <Trees className="size-3.5" />
        </button>
      </SimpleTooltip>
      <SimpleTooltip
        // The backtick renders in the mono font: the rounded doubutsu
        // fonts draw U+0060 as a narrow accent whose ink overhangs the
        // following space.
        tip={
          <>
            Project launcher (<span className="font-mono">`</span> or ⌘⇧P)
          </>
        }
      >
        <button
          type="button"
          onClick={toggleLauncher}
          aria-label="Project launcher"
          aria-keyshortcuts="` Meta+Shift+P"
          className={SIDEBAR_ICON_BUTTON}
        >
          <LayoutGrid className="size-3.5" />
        </button>
      </SimpleTooltip>
    </div>
  );
}
