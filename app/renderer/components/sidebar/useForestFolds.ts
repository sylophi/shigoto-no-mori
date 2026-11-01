// What the forest has folded open or shut, both views' folds: the
// tree's shelves, prefix groups, owners and folders, the projects
// folded on its inline list, and the inbox's shelves and prefix groups.
// The shelves start shut and the rest open. Transient on purpose, to
// keep the noise down on a fresh window, all but the inline list's
// folded projects, a stored preference (useCollapsedProjects).
import { useState } from "react";
import type { Project } from "@shigomori/contracts/schemas";
import { useCollapsedProjects } from "@/hooks/projects/useCollapsedProjects";
import { projectGroupKey, remoteGroupKeyOf } from "@shigomori/ui/lib/forest.ts";
import { withMember, withToggled } from "@shigomori/ui/lib/toggleSet.ts";
import type { GroupIdSet } from "@shigomori/ui/views/sidebar/buildSidebarRows.ts";
import type {
  GroupShelf,
  SidebarRow,
} from "@shigomori/ui/views/sidebar/sidebarRow.ts";
import type { RowHandlers } from "./VirtualRow";

// Whether a kind of fold starts open: a group's shelves (by shelf) and
// the inbox's start shut, the owners, folders and prefix groups open.
const OPEN_BY_DEFAULT = {
  agentWorking: false,
  shelved: false,
  hidden: false,
  inboxShelf: false,
  owner: true,
  folder: true,
  worktreeGroup: true,
  inboxGroup: true,
};
type FoldKind = keyof typeof OPEN_BY_DEFAULT;

const NONE_TOGGLED: Record<FoldKind, ReadonlySet<string>> = {
  agentWorking: new Set(),
  shelved: new Set(),
  hidden: new Set(),
  inboxShelf: new Set(),
  owner: new Set(),
  folder: new Set(),
  worktreeGroup: new Set(),
  inboxGroup: new Set(),
};

export function useForestFolds(projects: readonly Project[]) {
  // The keys toggled off their kind's default: the open ones of a kind
  // that starts shut, the shut ones of a kind that starts open.
  const [toggled, setToggled] = useState(NONE_TOGGLED);
  const toggle = (kind: FoldKind, key: string) =>
    setToggled((prev) => ({ ...prev, [kind]: withToggled(key)(prev[kind]) }));
  // Sets rather than flips, so a second call before the first lands is
  // harmless.
  const open = (kind: FoldKind, key: string) =>
    setToggled((prev) => ({
      ...prev,
      [kind]: withMember(prev[kind], key, !OPEN_BY_DEFAULT[kind]),
    }));
  const isOpen = (kind: FoldKind, key: string) =>
    OPEN_BY_DEFAULT[kind] !== toggled[kind].has(key);

  // The project folds are kept by group key (projectGroupKey), one per
  // repo: narrowed to a peer, a repo this machine also holds is drawn as
  // that peer's group, and it still reads and writes the one key the
  // local project's group goes by.
  const localGroupKeys = new Map(
    projects.map((project) => [
      project.id,
      projectGroupKey(project, undefined),
    ]),
  );
  const groupKeyOf = (groupId: string): string =>
    remoteGroupKeyOf(groupId) ?? localGroupKeys.get(groupId) ?? groupId;
  const worktreeGroupKey = (groupId: string, prefix: string) =>
    `${groupKeyOf(groupId)}\n${prefix}`;
  const { collapsedKeys, toggleCollapsed } = useCollapsedProjects();

  const shelfOpen = (shelf: GroupShelf): GroupIdSet => ({
    has: (groupId) => isOpen(shelf, groupKeyOf(groupId)),
  });
  // A fold's kind and key, for a row heading one.
  const foldOf = (row: SidebarRow): [FoldKind, string] | null => {
    switch (row.kind) {
      case "group-shelf":
        return [row.shelf, groupKeyOf(row.groupId)];
      case "worktree-group":
        return ["worktreeGroup", worktreeGroupKey(row.groupId, row.prefix)];
      case "owner-header":
        return ["owner", row.ownerKey];
      case "project-folder":
        return ["folder", row.foldKey];
      case "inbox-shelf":
        return ["inboxShelf", row.shelf];
      case "inbox-group":
        return ["inboxGroup", row.prefix];
      default:
        return null;
    }
  };

  return {
    // buildSidebarRows'.
    collapsed: {
      has: (groupId) => collapsedKeys.has(groupKeyOf(groupId)),
    } satisfies GroupIdSet,
    groupShelvesOpen: {
      agentWorking: shelfOpen("agentWorking"),
      shelved: shelfOpen("shelved"),
      hidden: shelfOpen("hidden"),
    } satisfies Record<GroupShelf, GroupIdSet>,
    worktreeGroupShut: (groupId: string, prefix: string) =>
      !isOpen("worktreeGroup", worktreeGroupKey(groupId, prefix)),
    shutOwners: toggled.owner,
    shutFolders: toggled.folder,
    // buildInboxRows'.
    inboxShelvesOpen: toggled.inboxShelf,
    shutInboxGroups: toggled.inboxGroup,
    toggleCollapsed,
    toggles: {
      onToggleShelved: (groupId, shelf) => toggle(shelf, groupKeyOf(groupId)),
      onToggleShelf: (shelf) => toggle("inboxShelf", shelf),
      onToggleOwner: (ownerKey) => toggle("owner", ownerKey),
      onToggleFolder: (foldKey) => toggle("folder", foldKey),
      onToggleWorktreeGroup: (groupId, prefix) =>
        toggle("worktreeGroup", worktreeGroupKey(groupId, prefix)),
      onToggleInboxGroup: (prefix) => toggle("inboxGroup", prefix),
    } satisfies Partial<RowHandlers>,
    // For revealing a worktree behind a shut fold (SidebarList): opens
    // the fold the row heads, if it is shut.
    openFold: (row: SidebarRow): boolean => {
      const fold = foldOf(row);
      if (fold === null || isOpen(...fold)) return false;
      open(...fold);
      return true;
    },
  };
}
