import { useState } from "react";
import { ArrowUpDown, Check } from "lucide-react";
import type { ProjectSortMode } from "@shared/schemas";
import { BackButton } from "@/components/ui/back-button";
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
import { hasLocalHost } from "@/lib/localHost";
import { AddProjectButton } from "./AddProjectButton";
import { SIDEBAR_ICON_BUTTON } from "./sidebarChrome";

interface SidebarToolbarProps {
  // Enter-only: the footer owns "Done arranging", so this never toggles
  // back out.
  onArrange: () => void;
  // Inside a project: the way back to the list of projects. Absent on
  // the list itself.
  onBack: (() => void) | undefined;
}

const SORT_OPTIONS: ReadonlyArray<{ value: ProjectSortMode; label: string }> = [
  { value: "alphabetical", label: "Alphabetical" },
  { value: "recent", label: "Most recently used" },
  { value: "frequent", label: "Most used" },
  { value: "manual", label: "Manual order" },
];

// Controls that only mean something to the project tree: ordering the
// projects, and getting back to them. Neither has an answer in the
// inbox (it's one list in one fixed order), so they live above the tree
// rather than in the footer, where they'd have to blink in and out as
// the view changes. The footer keeps what both views share.
//
// The left end is the tree's own level: the list of projects is what
// gets sorted, so inside a project the sort gives its place to the way
// back to that list, in the corner a back button is looked for (the
// one a page that takes the sidebar over puts there too,
// SidebarTakeover). Sorting is about this machine's own projects, so a
// hostless client's list leaves that corner empty. Add project sits at
// the right end in every case: it adds to the list of projects, and a
// hostless client adds onto one of its peers.
export function SidebarToolbar({ onArrange, onBack }: SidebarToolbarProps) {
  return (
    // Same left/right split as the footer below it: the control that
    // changes what the list shows sits left, the action sits right.
    <div className="flex items-center gap-1 px-2 pb-1">
      {onBack ? (
        <BackButton label="Projects" onClick={onBack} className="ml-0" />
      ) : (
        hasLocalHost && <SortMenu onArrange={onArrange} />
      )}
      <div className="flex-1" />
      <AddProjectButton />
    </div>
  );
}

function SortMenu({ onArrange }: { onArrange: () => void }) {
  const sortMode = useProjectSort();
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
    <DropdownMenu open={sortMenuOpen} onOpenChange={setSortMenuOpen}>
      {/* The tooltip hangs on a wrapper span, not the trigger button:
          merged onto the button, the tooltip would put
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
  );
}
