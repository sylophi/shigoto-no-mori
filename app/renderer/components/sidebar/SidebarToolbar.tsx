import type { ReactNode } from "react";
import { ArrowUpDown, Check } from "lucide-react";
import type {
  ProjectSortMode,
  WorktreeSortMode,
} from "@shigomori/contracts/schemas";
import { BackButton } from "@/components/ui/back-button";
import { cn } from "@/lib/utils";
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
} from "@/components/ui/dropdown-menu";
import {
  useGroupProjectsByOwner,
  useProjectSort,
  useSetGroupProjectsByOwner,
  useSetProjectSort,
} from "@/hooks/projects/useProjectSort";
import {
  useSetWorktreeSort,
  useWorktreeSorts,
} from "@/hooks/sharedSettings/useWorktreeSort";
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
export function SidebarToolbar({ onArrange, open }: SidebarToolbarProps) {
  return (
    // Same left/right split as the footer below it: the control that
    // changes what the list shows sits left, the action sits right.
    <div className="flex items-center gap-1 px-2 pb-1">
      {open ? (
        <BackButton label="Projects" onClick={open.onBack} className="ml-0" />
      ) : (
        <ProjectSortMenu onArrange={onArrange} />
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
  const groupByOwner = useGroupProjectsByOwner();
  const setGroupByOwner = useSetGroupProjectsByOwner();

  // Dragging only reorders coherently when the displayed order matches the
  // stored order, so arranging forces the manual sort before entering the
  // drag view.
  const arrangeManually = () => {
    setSortMode.mutate("manual");
    onArrange();
  };

  return (
    <ListMenu label={hasLocalHost ? "Sort projects" : "Group projects"}>
      {hasLocalHost && (
        <>
          <SortOptions
            options={PROJECT_SORT_OPTIONS}
            value={sortMode}
            onPick={(mode) => setSortMode.mutate(mode)}
          />
          <DropdownMenuSeparator />
        </>
      )}
      <CheckItem
        checked={groupByOwner}
        onClick={() => setGroupByOwner.mutate(!groupByOwner)}
      >
        Group by owner
      </CheckItem>
      {hasLocalHost && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={arrangeManually}>
            Set manual order
          </DropdownMenuItem>
        </>
      )}
    </ListMenu>
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
    <ListMenu label="Sort worktrees">
      <SortOptions
        options={WORKTREE_SORT_OPTIONS}
        value={sort}
        onPick={useSetWorktreeSort(groupKey)}
      />
    </ListMenu>
  );
}

// The same sort in a project header's menu, for the inline list, where
// every project is open at once and the toolbar sorts the projects.
export function WorktreeSortSubmenu({ groupKey }: { groupKey: string }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Sort worktrees</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <SortOptions
          options={WORKTREE_SORT_OPTIONS}
          value={useWorktreeSorts()(groupKey)}
          onPick={useSetWorktreeSort(groupKey)}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

// The toolbar's menu of how a list shows: the trigger and its popup,
// holding whatever the list offers.
function ListMenu({
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

function SortOptions<T extends string>({
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
        <CheckItem
          key={option.value}
          checked={value === option.value}
          onClick={() => onPick(option.value)}
        >
          {option.label}
        </CheckItem>
      ))}
    </DropdownMenuGroup>
  );
}

// A menu item with the check mark's room kept whether or not it is
// checked, so the labels line up.
function CheckItem({
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
