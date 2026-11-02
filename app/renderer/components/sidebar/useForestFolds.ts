// What the forest has folded open or shut, both views' folds: the
// tree's shelves, prefix groups, owners and folders, the projects
// folded on its inline list, and the inbox's shelves and prefix groups.
// The shelves start shut and the rest open. Transient on purpose, to
// keep the noise down on a fresh window, all but the inline list's
// folded projects, a stored preference (useCollapsedProjects).
import { useState } from "react";
import { useCollapsedProjects } from "@/hooks/projects/useCollapsedProjects";
import { withMember, withToggled } from "@shigomori/ui/lib/toggleSet.ts";
import type { GroupKeySet } from "@shigomori/ui/views/sidebar/buildSidebarRows.ts";
import type {
  GroupShelf,
  SidebarRow,
} from "@shigomori/ui/views/sidebar/sidebarRow.ts";
import type { RowHandlers } from "./VirtualRow";

// The kinds of fold that start shut: a group's shelves (by shelf) and
// the inbox's.
const NONE_OPENED: Record<GroupShelf | "inboxShelf", ReadonlySet<string>> = {
  agentWorking: new Set(),
  shelved: new Set(),
  hidden: new Set(),
  inboxShelf: new Set(),
};
// The kinds that start open: the owners, folders and prefix groups.
const NONE_SHUT: Record<
  "owner" | "folder" | "worktreeGroup" | "inboxGroup",
  ReadonlySet<string>
> = {
  owner: new Set(),
  folder: new Set(),
  worktreeGroup: new Set(),
  inboxGroup: new Set(),
};
type StartsShut = keyof typeof NONE_OPENED;
type FoldKind = StartsShut | keyof typeof NONE_SHUT;

const startsShut = (kind: FoldKind): kind is StartsShut => kind in NONE_OPENED;

// The project folds are kept by group key (projectGroupKey), one per
// repo, so narrowed to any device that holds it a repo keeps them.
const worktreeGroupKey = (groupKey: string, prefix: string) =>
  `${groupKey}\n${prefix}`;

export function useForestFolds() {
  // The open keys of the kinds that start shut, and the shut keys of
  // the rest.
  const [opened, setOpened] = useState(NONE_OPENED);
  const [shut, setShut] = useState(NONE_SHUT);
  const toggle = (kind: FoldKind, key: string) => {
    if (startsShut(kind)) {
      setOpened((prev) => ({ ...prev, [kind]: withToggled(key)(prev[kind]) }));
    } else {
      setShut((prev) => ({ ...prev, [kind]: withToggled(key)(prev[kind]) }));
    }
  };
  // Sets rather than flips, so a second call before the first lands is
  // harmless.
  const open = (kind: FoldKind, key: string) => {
    if (startsShut(kind)) {
      setOpened((prev) => ({
        ...prev,
        [kind]: withMember(prev[kind], key, true),
      }));
    } else {
      setShut((prev) => ({
        ...prev,
        [kind]: withMember(prev[kind], key, false),
      }));
    }
  };
  const isOpen = (kind: FoldKind, key: string) =>
    startsShut(kind) ? opened[kind].has(key) : !shut[kind].has(key);

  const { collapsedKeys, toggleCollapsed } = useCollapsedProjects();
  // A fold's kind and key, for a row heading one.
  const foldOf = (row: SidebarRow): [FoldKind, string] | null => {
    switch (row.kind) {
      case "group-shelf":
        return [row.shelf, row.groupKey];
      case "worktree-group":
        return ["worktreeGroup", worktreeGroupKey(row.groupKey, row.prefix)];
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
    collapsed: collapsedKeys satisfies GroupKeySet,
    groupShelvesOpen: {
      agentWorking: opened.agentWorking,
      shelved: opened.shelved,
      hidden: opened.hidden,
    } satisfies Record<GroupShelf, GroupKeySet>,
    worktreeGroupShut: (groupKey: string, prefix: string) =>
      shut.worktreeGroup.has(worktreeGroupKey(groupKey, prefix)),
    shutOwners: shut.owner,
    shutFolders: shut.folder,
    // buildInboxRows'.
    inboxShelvesOpen: opened.inboxShelf,
    shutInboxGroups: shut.inboxGroup,
    toggleCollapsed,
    toggles: {
      onToggleShelved: (groupKey, shelf) => toggle(shelf, groupKey),
      onToggleShelf: (shelf) => toggle("inboxShelf", shelf),
      onToggleOwner: (ownerKey) => toggle("owner", ownerKey),
      onToggleFolder: (foldKey) => toggle("folder", foldKey),
      onToggleWorktreeGroup: (groupKey, prefix) =>
        toggle("worktreeGroup", worktreeGroupKey(groupKey, prefix)),
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
