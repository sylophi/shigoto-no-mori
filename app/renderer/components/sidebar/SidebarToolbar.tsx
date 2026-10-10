// The project tree's toolbar (SidebarToolbarView): the projects' sort
// on the list, the way back and the worktree sort inside a project.
import type { WorktreeSortMode } from "@shigomori/contracts/schemas";
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
import {
  ProjectSortMenuView,
  SidebarToolbarView,
  WorktreeSortMenuView,
  WorktreeSortSubmenuView,
} from "@shigomori/ui/views/sidebar/SidebarToolbarView.tsx";

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

export function SidebarToolbar({ onArrange, open }: SidebarToolbarProps) {
  return (
    <SidebarToolbarView
      onBack={open?.onBack}
      projectSort={open ? undefined : <ProjectSortMenu onArrange={onArrange} />}
      worktreeSort={
        open && <WorktreeSortMenu groupKey={open.groupKey} sort={open.sort} />
      }
      addProject={<AddProjectButton />}
    />
  );
}

function ProjectSortMenu({ onArrange }: { onArrange: () => void }) {
  const sortMode = useProjectSort();
  const setSortMode = useSetProjectSort();
  const groupByOwner = useGroupProjectsByOwner();
  const setGroupByOwner = useSetGroupProjectsByOwner();
  return (
    <ProjectSortMenuView
      hasLocalHost={hasLocalHost}
      sortMode={sortMode}
      onSort={(mode) => setSortMode.mutate(mode)}
      groupByOwner={groupByOwner}
      onGroupByOwner={(group) => setGroupByOwner.mutate(group)}
      onArrange={() => {
        setSortMode.mutate("manual");
        onArrange();
      }}
    />
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
    <WorktreeSortMenuView sort={sort} onPick={useSetWorktreeSort(groupKey)} />
  );
}

// The worktree sort in a project header's menu (the inline list's).
export function WorktreeSortSubmenu({ groupKey }: { groupKey: string }) {
  return (
    <WorktreeSortSubmenuView
      sort={useWorktreeSorts()(groupKey)}
      onPick={useSetWorktreeSort(groupKey)}
    />
  );
}
