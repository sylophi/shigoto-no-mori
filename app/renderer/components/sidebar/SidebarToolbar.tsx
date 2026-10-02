import { type ReactNode, useState } from "react";
import { ArrowUpDown, Check } from "lucide-react";
import type { ProjectSortMode, WorktreeSortMode } from "@shared/schemas";
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
import { useSetWorktreeSort } from "@/hooks/sharedSettings/useWorktreeSort";
import { hasLocalHost } from "@/lib/localHost";
import { AddProjectButton } from "./AddProjectButton";
import { SIDEBAR_ICON_BUTTON } from "./sidebarChrome";

interface SidebarToolbarProps {
  // Enter-only: the footer owns "Done arranging", so this never toggles
  // back out.
  onArrange: () => void;
  // Inside a project: its worktree sort and the group key
  // (projectGroupKey) the sort is kept by, and the way back to the
  // list of projects. Absent on the list itself.
  open:
    | { groupKey: string; sort: WorktreeSortMode; onBack: () => void }
    | undefined;
}

type SortOption<T> = { value: T; label: string };

const PROJECT_SORT_OPTIONS: ReadonlyArray<SortOption<ProjectSortMode>> = [
  { value: "alphabetical", label: "Alphabetical" },
  { value: "recent", label: "Most recently used" },
  { value: "frequent", label: "Most used" },
  { value: "manual", label: "Manual order" },
];

const WORKTREE_SORT_OPTIONS: ReadonlyArray<SortOption<WorktreeSortMode>> = [
  { value: "name", label: "Name" },
  { value: "recent", label: "Most recently active" },
  { value: "created", label: "Most recently created" },
];

// Controls that only mean something to the project tree: ordering what
// it lists, and getting back to the projects. Neither has an answer in
// the inbox (it's one list in one fixed order), so they live above the
// tree rather than in the footer, where they'd have to blink in and out
// as the view changes. The footer keeps what both views share.
//
// The left end is the tree's own level. On the list of projects it
// sorts them. Sorting is about this machine's own projects, so a
// hostless client's list leaves that corner empty. Inside a project
// the corner holds the way back to that list, where a back button is
// looked for (the one a page that takes the sidebar over puts there
// too, SidebarTakeover). The project's own worktree sort goes to the
// right end instead, beside add project, so the way back stands alone.
// Every device's worktrees are in that sort, so a hostless client has
// it too. Add project sits at the right end in every case: it adds to
// the list of projects, and a hostless client adds onto one of its
// peers.
export function SidebarToolbar({ onArrange, open }: SidebarToolbarProps) {
  return (
    // Same left/right split as the footer below it: the control that
    // changes what the list shows sits left, the action sits right.
    <div className="flex items-center gap-1 px-2 pb-1">
      {open ? (
        <BackButton label="Projects" onClick={open.onBack} className="ml-0" />
      ) : (
        hasLocalHost && <ProjectSortMenu onArrange={onArrange} />
      )}
      <div className="flex-1" />
      {open && <WorktreeSortMenu groupKey={open.groupKey} sort={open.sort} />}
      <AddProjectButton />
    </div>
  );
}

function ProjectSortMenu({ onArrange }: { onArrange: () => void }) {
  const sortMode = useProjectSort();
  const setSortMode = useSetProjectSort();

  // Dragging only reorders coherently when the displayed order matches the
  // stored order, so arranging forces the manual sort before entering the
  // drag view.
  const arrangeManually = () => {
    setSortMode.mutate("manual");
    onArrange();
  };

  return (
    <SortMenu
      tip="Sort projects"
      options={PROJECT_SORT_OPTIONS}
      value={sortMode}
      onPick={(mode) => setSortMode.mutate(mode)}
    >
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={arrangeManually}>
        Set manual order
      </DropdownMenuItem>
    </SortMenu>
  );
}

function WorktreeSortMenu({
  groupKey,
  sort,
}: {
  groupKey: string;
  sort: WorktreeSortMode;
}) {
  return (
    <SortMenu
      tip="Sort worktrees"
      options={WORKTREE_SORT_OPTIONS}
      value={sort}
      onPick={useSetWorktreeSort(groupKey)}
    />
  );
}

function SortMenu<T extends string>({
  tip,
  options,
  value,
  onPick,
  children,
}: {
  // The trigger's tooltip and accessible name.
  tip: string;
  options: ReadonlyArray<SortOption<T>>;
  value: T;
  onPick: (value: T) => void;
  // Anything the menu offers below the orders.
  children?: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      {/* The tooltip hangs on a wrapper span, not the trigger button:
          merged onto the button, the tooltip would put
          data-popup-open next to aria-haspopup, which doubutsu
          styles as "menu open". Disabled while the menu is open so
          the tip can't cover the popup. */}
      <SimpleTooltip tip={tip} disabled={menuOpen}>
        <span className="inline-flex">
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label={tip}
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
          {options.map((option) => (
            <DropdownMenuItem
              key={option.value}
              onClick={() => onPick(option.value)}
            >
              <Check
                className={cn(
                  "size-3.5",
                  value === option.value ? "opacity-100" : "opacity-0",
                )}
              />
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
