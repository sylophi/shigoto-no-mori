import type { ReactNode } from "react";
import { ArrowUpDown, Check } from "lucide-react";
import type {
  ProjectSortMode,
  WorktreeSortMode,
} from "@shigomori/contracts/schemas";
import { BackButton } from "@shigomori/ui/primitives/back-button.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@shigomori/ui/primitives/dropdown-menu.tsx";
import { SIDEBAR_ICON_BUTTON } from "./sidebarChrome";

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
// hostless client's menu there offers only the grouping by owner,
// which splits any device's projects the same. Inside a project
// the corner holds the way back to that list, where a back button is
// looked for (the one a page that takes the sidebar over puts there
// too, SidebarTakeover). The project's own worktree sort goes to the
// right end instead, beside add project, so the way back stands alone.
// Every device's worktrees are in that sort, so a hostless client has
// it too. Add project sits at the right end in every case: it adds to
// the list of projects, and a hostless client adds onto one of its
// peers.
export function SidebarToolbarView({
  onBack,
  projectSort,
  worktreeSort,
  addProject,
}: {
  // Inside a project: the way back to the list of projects, and the
  // project's worktree sort (WorktreeSortMenuView). On the list, the
  // projects' sort menu (ProjectSortMenuView) instead.
  onBack?: () => void;
  projectSort?: ReactNode;
  worktreeSort?: ReactNode;
  // The add-project button (AddProjectButton).
  addProject: ReactNode;
}) {
  return (
    // Same left/right split as the footer below it: the control that
    // changes what the list shows sits left, the action sits right.
    <div className="flex items-center gap-1 px-2 pb-1">
      {onBack ? (
        <BackButton label="Projects" onClick={onBack} className="ml-0" />
      ) : (
        projectSort
      )}
      <div className="flex-1" />
      {worktreeSort}
      {addProject}
    </div>
  );
}

// The list of projects' menu: their sort, which this machine's own
// projects take, and the grouping by owner, which any device's do.
// Dragging only reorders coherently when the displayed order matches
// the stored order, so arranging forces the manual sort first.
export function ProjectSortMenuView({
  hasLocalHost,
  sortMode,
  onSort,
  groupByOwner,
  onGroupByOwner,
  onArrange,
}: {
  hasLocalHost: boolean;
  sortMode: ProjectSortMode;
  onSort: (mode: ProjectSortMode) => void;
  groupByOwner: boolean;
  onGroupByOwner: (group: boolean) => void;
  // Picks the manual sort and enters arranging.
  onArrange: () => void;
}) {
  return (
    <ListMenuView label={hasLocalHost ? "Sort projects" : "Group projects"}>
      {hasLocalHost && (
        <>
          <SortOptionsView
            options={PROJECT_SORT_OPTIONS}
            value={sortMode}
            onPick={onSort}
          />
          <DropdownMenuSeparator />
        </>
      )}
      <CheckItemView
        checked={groupByOwner}
        onClick={() => onGroupByOwner(!groupByOwner)}
      >
        Group by owner
      </CheckItemView>
      {hasLocalHost && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onArrange}>
            Set manual order
          </DropdownMenuItem>
        </>
      )}
    </ListMenuView>
  );
}

// An open project's worktree sort, in the toolbar.
export function WorktreeSortMenuView({
  sort,
  onPick,
}: {
  sort: WorktreeSortMode;
  onPick: (sort: WorktreeSortMode) => void;
}) {
  return (
    <ListMenuView label="Sort worktrees">
      <SortOptionsView
        options={WORKTREE_SORT_OPTIONS}
        value={sort}
        onPick={onPick}
      />
    </ListMenuView>
  );
}

// The same sort in a project header's menu, for the inline list, where
// every project is open at once and the toolbar sorts the projects.
export function WorktreeSortSubmenuView({
  sort,
  onPick,
}: {
  sort: WorktreeSortMode;
  onPick: (sort: WorktreeSortMode) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Sort worktrees</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <SortOptionsView
          options={WORKTREE_SORT_OPTIONS}
          value={sort}
          onPick={onPick}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

// The toolbar's menu of how a list shows: the trigger and its popup,
// holding whatever the list offers.
export function ListMenuView({
  label,
  children,
}: {
  // The trigger's accessible name.
  label: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className={SIDEBAR_ICON_BUTTON}
          >
            <ArrowUpDown className="size-3.5" />
          </button>
        }
      />
      {/* Anchored under the trigger now that it sits at the top of the
          sidebar rather than the bottom. */}
      <DropdownMenuContent align="end" side="bottom" sideOffset={2}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SortOptionsView<T extends string>({
  options,
  value,
  onPick,
}: {
  options: ReadonlyArray<SortOption<T>>;
  value: T;
  onPick: (value: T) => void;
}) {
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Sort by</DropdownMenuLabel>
      {options.map((option) => (
        <CheckItemView
          key={option.value}
          checked={value === option.value}
          onClick={() => onPick(option.value)}
        >
          {option.label}
        </CheckItemView>
      ))}
    </DropdownMenuGroup>
  );
}

// A menu item with the check mark's room kept whether or not it is
// checked, so the labels line up.
export function CheckItemView({
  checked,
  onClick,
  children,
}: {
  checked: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenuItem onClick={onClick}>
      <Check
        className={cn("size-3.5", checked ? "opacity-100" : "opacity-0")}
      />
      {children}
    </DropdownMenuItem>
  );
}
