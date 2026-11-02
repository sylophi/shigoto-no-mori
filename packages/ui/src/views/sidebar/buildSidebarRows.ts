import {
  placeByStack,
  pullRequestStackFor,
  trunkOf,
} from "@shigomori/contracts/pullRequestStack";
import { groupPrefixOf } from "@shigomori/contracts/sharedSettings";
import {
  type ForestDevice,
  type ForestGroup,
  type ForestItem,
  forestGroups,
  groupShelfOf,
  type LocalSide,
  mirrorBadgeOf,
  type MirrorPair,
  mirrorPairsOf,
  projectGroupKey,
  worktreeAt,
  worktreeRowKey,
} from "../../lib/forest.ts";
import type { Worktree, WorktreeSortMode } from "@shigomori/contracts/schemas";
import type { SidebarDeviceBadge } from "./DeviceBadgeView.tsx";
import {
  ALL_KEY,
  groupSections,
  ownerKeyOf,
  type ProjectGroupOrder,
} from "./projectGroupOrder.ts";
import {
  GROUP_SHELVES,
  type GroupShelf,
  type ProjectListRow,
  type RemoteProjectMember,
  type SidebarRow,
  type SidebarViewModel,
} from "./sidebarRow.ts";
import { sortWorktrees } from "../../lib/sortWorktrees.ts";

// A set of group keys (projectGroupKey) as the builder asks it: only
// whether one is in.
export type GroupKeySet = Pick<ReadonlySet<string>, "has">;

export interface BuildSidebarRowsArgs {
  // Every device's projects, this machine's first (forestGroups). The
  // PR maps are what gathers a stack's rows together.
  items: readonly ForestItem[];
  // The group key (projectGroupKey) of the project the tree is inside,
  // null on the list of projects. A key no group here goes by (the
  // device filter narrowed the project away, or it was removed) reads
  // as the list rather than as an empty tree. Unread while `inline`.
  openKey: string | null;
  // Lists every project's worktrees under its header on the list of
  // projects, the groups in `collapsed` drawn as their header alone,
  // rather than one project at a time. Null steps into projects.
  inline: { collapsed: GroupKeySet } | null;
  // Where each group sits (projectGroupOrder), decided over every
  // device's projects so the device filter never reorders the groups.
  order: ProjectGroupOrder;
  // How a project's worktrees are ordered, by group key
  // (useWorktreeSorts).
  worktreeSort: (groupKey: string) => WorktreeSortMode;
  // The groups whose shelf is open, per shelf.
  openShelves: Record<GroupShelf, GroupKeySet>;
  // Worktrees starting with one of these fold away like shelved ones.
  hiddenPrefixes: readonly string[];
  // Whether a working agent session shelves its worktree (isAgentWorking).
  allowAgentWorking: boolean;
  // Gathers the open project's worktrees starting with one of
  // `prefixes` under a header per prefix (groupPrefixOf), those `shut`
  // names drawn as their header alone. Null groups nothing.
  byPrefix: {
    prefixes: readonly string[];
    shut: (groupKey: string, prefix: string) => boolean;
  } | null;
  arrangeMode: boolean;
  // Splits the list of projects under a header per owner (ownerOf),
  // the owners where `order` puts them, the ones in `shut` drawn as
  // their header alone, and the pinned projects above them all. Null
  // lists the projects as one run, and so does a list with a single
  // owner, which a header would only repeat.
  byOwner: { shut: ReadonlySet<string> } | null;
  // The folders (ProjectGroupOrder.folders) drawn as their header
  // alone, by fold key (the "project-folder" row's).
  shutFolders: ReadonlySet<string>;
  // The mirrored pairs (useMirrorLinks). A pair is one worktree on two
  // machines, so the folded side's row folds into the kept side's.
  mirrors: readonly MirrorPair[];
  // This device's sides of pairs whose own projects the build doesn't
  // list (localSidesWith), by worktreeAt: each is listed among its
  // peer's rows, and the peer's row folds into it as into a listed
  // local row, so a pair reads under the peer's filter as it does
  // under every device.
  localSides?: ReadonlyMap<string, LocalSide>;
  // Every peer's badge off the device registry (useDeviceBadges),
  // whether or not its rows are in `items`: the device filter narrows
  // the rows, and a local row's mirror still names its peer while the
  // peer's own rows are hidden.
  deviceBadges: ReadonlyMap<string, SidebarDeviceBadge>;
}

// Flattens every device's items into the SidebarRow list the
// virtualizer renders. A plain function, not a hook: the reads are
// subscribed once by the Sidebar and handed to whichever builder the
// active view needs, so flipping views doesn't tear the subscriptions
// down and re-probe git for every project.
//
// No memo, deliberately. The result is O(rows) to rebuild and the inputs
// change whenever anything on screen does, so a cache here would need a
// deep fingerprint to stay correct and would save nothing.
export function buildSidebarRows({
  items,
  openKey,
  inline,
  order,
  worktreeSort,
  openShelves,
  hiddenPrefixes,
  allowAgentWorking,
  byPrefix,
  arrangeMode,
  byOwner,
  shutFolders,
  mirrors,
  localSides,
  deviceBadges,
}: BuildSidebarRowsArgs): SidebarViewModel {
  if (arrangeMode) {
    // Arranging is this machine's stored order, a row per project.
    const rows: SidebarRow[] = items
      .filter((item) => item.device.isThisDevice)
      .map(({ project, device }) => ({
        kind: "project",
        key: `p:${project.id}`,
        groupId: project.id,
        groupKey: projectGroupKey(project, device),
        project,
        local: true,
        expanded: false,
        // Arranging draws the stored order, which the pins don't lead,
        // and no folders.
        pinned: false,
        folder: null,
        folders: [],
        section: ALL_KEY,
        devices: [],
        members: [],
      }));
    return {
      rows,
      emptyMessage: null,
      revealKey: (projectId) => headerKeyIfPresent(rows, projectId),
    };
  }

  const pairs = mirrorPairsOf(mirrors);
  const groups = sortedGroups(items, order);
  const file = groupFiler(
    {
      groups,
      openShelves,
      hiddenPrefixes,
      allowAgentWorking,
      localSides,
      deviceBadges,
    },
    pairs,
  );
  // A run of rows per group under its header, so the list's pinned and
  // owner sections move a project's worktrees with it.
  const chunks: Chunk[] = [];
  let pinned: SidebarRow | undefined;
  // The header each row behind a shut fold stands behind, for
  // revealKey.
  const shutFoldRows = new Map<string, string>();
  // Every row filed, by worktreeAt, for revealKey.
  const filedKeys = new Map<string, string>();
  const hide = (rows: readonly WorktreeRow[], foldKey: string) => {
    for (const row of rows) shutFoldRows.set(row.key, foldKey);
  };
  // The tree draws one level: the open project on its own, or the list
  // of projects, a header each, and inline each one's rows under it.
  // (A repo registered twice here is two groups under one key, and
  // opens as both.)
  const open =
    inline === null ? groups.filter((group) => group.key === openKey) : [];
  const inProject = open.length > 0;
  for (const group of inProject ? open : groups) {
    const { id: groupId, key: groupKey } = group;
    const [lead] = group.items;
    // Inline, whether the project is folded to its header.
    const isFolded =
      inline === null ? undefined : inline.collapsed.has(groupKey);
    const rowsDrawn = inProject || isFolded === false;
    const filed = file(group);
    const { visible, shelves } = filed;
    for (const row of [visible, ...GROUP_SHELVES.map((s) => shelves[s])].flat())
      filedKeys.set(worktreeAt(row.deviceId, row.worktree.id), row.key);
    const header = projectHeader(group, filed, {
      order,
      byOwner: byOwner !== null,
      expanded: inProject,
      folded: isFolded,
    });
    const rows: SidebarRow[] = [];
    chunks.push({ header, rows });
    // The open project's header stands over its rows rather than among
    // them. A repo registered twice opens as both its groups, and those
    // keep their headers in the rows, each over its own.
    if (inProject && open.length === 1) pinned = header;
    if (lead.project.pathExists === false) continue;
    if (!rowsDrawn) {
      // A folded project's header stands in for its rows.
      if (isFolded) {
        hide(visible, header.key);
        for (const shelf of GROUP_SHELVES) hide(shelves[shelf], header.key);
      }
      continue;
    }
    if (filed.unlisted !== null) {
      const { kind, item } = filed.unlisted;
      rows.push({
        kind,
        key: `${kind === "worktree-skeleton" ? "sk" : "err"}:${item.project.id}`,
        groupId,
      });
    }
    // In the project's sort, then a stack's rows sit together on a
    // rail, top layer first, wherever its layers are checked out:
    // gathered at its first layer's place. The trunk comes off the
    // first listing that names one, and the PRs off the group's lead.
    const trunk = group.items
      .map((item) => trunkOf(item.worktrees))
      .find((branch) => branch !== undefined);
    const prs = lead.pullRequests;
    const placed = (filedRows: WorktreeRow[]): SidebarRow[] =>
      placeByStack(
        sortWorktrees(filedRows, worktreeSort(groupKey), (row) => row.worktree),
        (row) => row.worktree.branch,
        prs,
        trunk,
      ).map(({ item, position, rail }) => {
        // The rows were built for this build, so they are ours to fill in.
        item.stack = position;
        item.stackRail = rail;
        return item;
      });
    // A fold's rows: placed when it is open, else left out with the
    // fold's header standing in for each.
    const foldRows = (
      foldedRows: WorktreeRow[],
      shown: boolean,
      foldKey: string,
    ): SidebarRow[] => {
      if (shown) return placed(foldedRows);
      hide(foldedRows, foldKey);
      return [];
    };
    // The open rows a prefix gathers sit under its header, after the
    // rest, the prefixes in their (sorted) order. A stack goes whole to
    // where its lowest listed layer files, so its rail stays in one
    // piece under one header.
    const { prefixes, shut } = byPrefix ?? NO_PREFIX_GROUPS;
    // Stacks by their bottom branch, each with the prefix its lowest
    // listed layer files under.
    const stackOf = (worktree: Worktree) =>
      worktree.detached
        ? null
        : pullRequestStackFor(prs, worktree.branch, trunk);
    const stackPrefix = new Map<
      string,
      { index: number; prefix: string | null }
    >();
    for (const { worktree } of visible) {
      const stack = stackOf(worktree);
      const bottom = stack?.entries[0]?.branch;
      if (!stack || bottom === undefined) continue;
      const held = stackPrefix.get(bottom);
      if (held && held.index <= stack.index) continue;
      stackPrefix.set(bottom, {
        index: stack.index,
        prefix: groupPrefixOf(worktree, prefixes),
      });
    }
    const rest: WorktreeRow[] = [];
    const grouped = new Map<string, WorktreeRow[]>();
    for (const row of visible) {
      const bottom = stackOf(row.worktree)?.entries[0]?.branch;
      const prefix =
        bottom === undefined
          ? groupPrefixOf(row.worktree, prefixes)
          : (stackPrefix.get(bottom)?.prefix ?? null);
      if (prefix === null) {
        rest.push(row);
        continue;
      }
      const bucket = grouped.get(prefix) ?? [];
      grouped.set(prefix, bucket);
      bucket.push(row);
    }
    rows.push(...placed(rest));
    for (const prefix of prefixes) {
      const bucket = grouped.get(prefix);
      if (!bucket) continue;
      const groupOpen = !shut(groupKey, prefix);
      const headerKey = `g:${groupId}:${prefix}`;
      rows.push(
        {
          kind: "worktree-group",
          key: headerKey,
          groupId,
          groupKey,
          prefix,
          count: bucket.length,
          expanded: groupOpen,
        },
        ...foldRows(bucket, groupOpen, headerKey),
      );
    }
    for (const shelf of GROUP_SHELVES) {
      const shelfRows = shelves[shelf];
      if (shelfRows.length === 0) continue;
      const shelfOpen = openShelves[shelf].has(groupKey);
      const shelfKey = `${shelf}:${groupId}`;
      rows.push(
        {
          kind: "group-shelf",
          key: shelfKey,
          groupId,
          groupKey,
          shelf,
          count: shelfRows.length,
          expanded: shelfOpen,
        },
        ...foldRows(shelfRows, shelfOpen, shelfKey),
      );
    }
  }

  const drawn = inProject
    ? chunks.flatMap(({ header, rows }) =>
        header === pinned ? rows : [header, ...rows],
      )
    : listRows(
        chunks,
        order,
        byOwner?.shut ?? EMPTY,
        shutFolders,
        (key, foldKey) => shutFoldRows.set(key, foldKey),
      );
  return {
    rows: drawn,
    pinned,
    level: inProject ? openKey : inline === null ? null : undefined,
    // Every project renders a header, so "no rows" here only ever means
    // "no projects", which the shell already has its own answer for.
    emptyMessage: null,
    revealKey: (_projectId, worktreeId, deviceId) => {
      // A row behind a shut shelved or hidden fold, or a shut group:
      // its header stands in for it. Inline, a folded project
      // can itself be behind a shut owner, whose header then does.
      const shown = (key: string | undefined): string | undefined => {
        if (key === undefined) return undefined;
        if (drawn.some((r) => r.key === key)) return key;
        return shown(shutFoldRows.get(key));
      };
      // A row is absent while its listing is in flight or the tree is
      // not inside its project, which reveals nothing: the shell opens
      // the project of the worktree on screen, and the row is revealed
      // once it draws. Settling for the header would mark the reveal
      // done before then. A worktree folded into its pair's kept row
      // reveals that.
      const at = worktreeAt(deviceId, worktreeId);
      const kept = pairs.keptOf.get(at);
      return (
        shown(filedKeys.get(at)) ?? shown(kept && filedKeys.get(kept)) ?? null
      );
    },
  };
}

const NO_PREFIX_GROUPS: NonNullable<BuildSidebarRowsArgs["byPrefix"]> = {
  prefixes: [],
  shut: () => false,
};

const emptyShelves = <T>(): Record<GroupShelf, T[]> => ({
  agentWorking: [],
  shelved: [],
  hidden: [],
});

// Arranging draws no worktree rows, so a project's header is the
// closest thing there is to reveal.
function headerKeyIfPresent(rows: SidebarRow[], projectId: string) {
  const key = `p:${projectId}`;
  return rows.some((r) => r.key === key) ? key : null;
}

// A group's header and, when they are drawn, the rows under it.
interface Chunk {
  header: ProjectListRow;
  rows: SidebarRow[];
}

const EMPTY: ReadonlySet<string> = new Set();

const rowsOf = ({ header, rows }: Chunk): SidebarRow[] => [header, ...rows];

// The list of projects' rows: the pinned ones first, the last of them
// marked for the gap under it when more follow and it is a header
// alone, then the rest's sections (groupSections), each owner's and
// folder's under its header. A shut header's rows are handed to
// `hide`, the header standing in for them (revealKey).
function listRows(
  chunks: readonly Chunk[],
  order: ProjectGroupOrder,
  shutOwners: ReadonlySet<string>,
  shutFolders: ReadonlySet<string>,
  hide: (key: string, foldKey: string) => void,
): SidebarRow[] {
  const { pinned, runs } = groupSections(
    chunks,
    (chunk) => chunk.header,
    order,
  );
  const lead = pinned.flatMap(rowsOf);
  const after: SidebarRow[] = [];
  for (const { owner, section, items, folders, loose } of runs) {
    if (owner !== null) {
      const expanded = !shutOwners.has(owner.key);
      after.push({
        kind: "owner-header",
        key: owner.headerKey,
        ownerKey: owner.key,
        label: owner.label,
        count: items.length,
        expanded,
      });
      if (!expanded) {
        for (const row of items.flatMap(rowsOf)) hide(row.key, owner.headerKey);
        continue;
      }
    }
    for (const folder of folders) {
      const expanded = !shutFolders.has(folder.foldKey);
      after.push({
        kind: "project-folder",
        key: folder.headerKey,
        section,
        foldKey: folder.foldKey,
        name: folder.name,
        groupKeys: folder.groupKeys,
        count: folder.items.length,
        expanded,
      });
      for (const row of folder.items.flatMap(rowsOf))
        if (expanded) after.push({ ...row, nested: true });
        else hide(row.key, folder.headerKey);
    }
    after.push(...loose.flatMap(rowsOf));
  }
  const end = lead.at(-1);
  if (end?.kind === "project" && after.length > 0)
    lead[lead.length - 1] = { ...end, pinnedEnd: true };
  return [...lead, ...after];
}

// Every group in the order's place for it. Every group is in the order,
// which was built over a superset of these items. The fallback only
// keeps the comparator total.
function sortedGroups(
  items: readonly ForestItem[],
  order: ProjectGroupOrder,
): ForestGroup[] {
  const rankOf = (group: ForestGroup) =>
    order.groups.get(group.id) ?? order.groups.size;
  return forestGroups(items).toSorted((a, b) => rankOf(a) - rankOf(b));
}

// What a group lists, the open rows and each fold's. Worked out the
// same way at both levels, so the list's count is the rows the project
// draws once opened. `unlisted` is the row standing in for a listing
// that is loading or failed, and the item it stands for.
interface FiledGroup {
  visible: WorktreeRow[];
  shelves: Record<GroupShelf, WorktreeRow[]>;
  unlisted: {
    kind: "worktree-skeleton" | "worktree-error";
    item: ForestItem;
  } | null;
}

// Files a group as it draws. Filing one lists this device's sides of
// its pairs (listedLocal), which the peers' rows filed after them fold
// into, so the filer is called once per group, in drawing order.
function groupFiler(
  {
    groups,
    openShelves,
    hiddenPrefixes,
    allowAgentWorking,
    localSides = new Map(),
    deviceBadges,
  }: Pick<
    BuildSidebarRowsArgs,
    | "openShelves"
    | "hiddenPrefixes"
    | "allowAgentWorking"
    | "localSides"
    | "deviceBadges"
  > & { groups: readonly ForestGroup[] },
  { keptOf, foldedOf }: ReturnType<typeof mirrorPairsOf>,
): (group: ForestGroup) => FiledGroup {
  const shelfOf = (worktree: Worktree) =>
    groupShelfOf(worktree, hiddenPrefixes, allowAgentWorking);
  const localRow = (
    device: ForestDevice,
    worktree: Worktree,
    pr: WorktreeRow["pr"],
    group: ForestGroup,
  ): WorktreeRow => {
    const folded = foldedOf.get(worktreeAt(device.deviceId, worktree.id));
    return {
      kind: "worktree",
      key: worktreeRowKey(device, worktree.id),
      deviceId: device.deviceId,
      worktree,
      mirror: mirrorBadgeOf(folded, deviceBadges),
      mirrorWorktreeId: folded?.worktreeId,
      pr,
      stack: null,
      shelf: shelfOf(worktree),
      groupId: group.id,
    };
  };
  // The local rows this build lists, decided up front: a peer's row
  // folds only into a local row that is really on screen. Its listing
  // still loading or failed, or its fold shut, the peer's row stays
  // its own, or a healthy worktree would vanish behind a local gap. The
  // one exception is a peer's row behind the same fold of the same
  // group as the local row: the two only ever show together, so it
  // folds in and the fold's count holds still across the toggle.
  const listedLocal = new Map<
    string,
    { groupId: string; shelf: GroupShelf | null; shown: boolean }
  >();
  const list = (
    device: ForestDevice,
    worktree: Worktree,
    group: ForestGroup,
  ) => {
    const shelf = shelfOf(worktree);
    listedLocal.set(worktreeAt(device.deviceId, worktree.id), {
      groupId: group.id,
      shelf,
      shown: shelf === null || openShelves[shelf].has(group.key),
    });
  };
  for (const group of groups)
    for (const item of group.items)
      if (
        item.device.isThisDevice &&
        item.listing === "ready" &&
        item.project.pathExists !== false
      )
        for (const worktree of item.worktrees)
          list(item.device, worktree, group);
  const foldedInto = (
    at: string,
    shelf: GroupShelf | null,
    groupId: string,
  ): boolean => {
    const kept = keptOf.get(at);
    const listed = kept && listedLocal.get(kept);
    if (!listed) return false;
    return (
      listed.shown ||
      (shelf !== null && listed.shelf === shelf && listed.groupId === groupId)
    );
  };
  return (group) => {
    // Peers' worktrees of this same repo sort in among the local rows
    // (sortWorktrees), and render on EVERY path below: a group whose
    // local listing is still loading, or failed, would otherwise hide
    // the peer's perfectly healthy worktrees behind a local-only
    // failure. Their shelved and hidden ones share the group's folds
    // with the local ones, so a device showing only peers' work (the
    // web client) can still reach them. This machine's rows come first,
    // which a tie in the sort keeps.
    const local: WorktreeRow[] = [];
    const peers: WorktreeRow[] = [];
    const [lead] = group.items;
    for (const item of group.items) {
      const { device } = item;
      if (device.isThisDevice) {
        if (item.listing === "ready")
          for (const worktree of item.worktrees)
            local.push(
              localRow(
                device,
                worktree,
                item.pullRequests[worktree.branch],
                group,
              ),
            );
        continue;
      }
      for (const worktree of item.worktrees) {
        // This device's side of a pair with the peer, filed among the
        // group's local rows and listed for the peer's row to fold into.
        const paired = keptOf.get(worktreeAt(device.deviceId, worktree.id));
        const side = paired === undefined ? undefined : localSides.get(paired);
        if (side !== undefined) {
          local.push(
            localRow(
              side.device,
              side.worktree,
              lead.pullRequests[side.worktree.branch],
              group,
            ),
          );
          list(side.device, side.worktree, group);
        }
      }
    }
    for (const { device, worktrees, pullRequests } of group.items) {
      if (device.isThisDevice) continue;
      for (const worktree of worktrees) {
        const shelf = shelfOf(worktree);
        // The kept row of a mirrored pair stands for both copies.
        if (
          foldedInto(worktreeAt(device.deviceId, worktree.id), shelf, group.id)
        )
          continue;
        peers.push({
          kind: "worktree",
          key: worktreeRowKey(device, worktree.id),
          deviceId: device.deviceId,
          worktree,
          device,
          pr: pullRequests[worktree.branch],
          stack: null,
          shelf,
          groupId: group.id,
        });
      }
    }
    const visible: WorktreeRow[] = [];
    const shelves = emptyShelves<WorktreeRow>();
    for (const row of [...local, ...peers])
      (row.shelf === null ? visible : shelves[row.shelf]).push(row);
    const pending = group.items.find((item) => item.listing !== "ready");
    return {
      visible,
      shelves,
      unlisted:
        pending === undefined
          ? null
          : {
              kind:
                pending.listing === "loading"
                  ? "worktree-skeleton"
                  : "worktree-error",
              item: pending,
            },
    };
  };
}

// A group's header: on the list of projects, or `expanded` over the
// open project. `folded` is the inline list's (the project row's).
function projectHeader(
  group: ForestGroup,
  { visible, unlisted }: FiledGroup,
  {
    order,
    byOwner,
    expanded,
    folded,
  }: {
    order: ProjectGroupOrder;
    byOwner: boolean;
    expanded: boolean;
    folded: boolean | undefined;
  },
): ProjectListRow {
  const [{ project, device }] = group.items;
  const peers = group.items.filter((item) => !item.device.isThisDevice);
  const section = byOwner ? ownerKeyOf(project) : ALL_KEY;
  const rowsDrawn = expanded || folded === false;
  const missing = project.pathExists === false;
  return {
    kind: "project",
    key: `p:${group.id}`,
    groupId: group.id,
    groupKey: group.key,
    project,
    local: device.isThisDevice,
    expanded,
    folded,
    pinned: order.pinned.has(group.key),
    folder: order.folders.get(group.key) ?? null,
    folders: [...(order.filed.get(section)?.keys() ?? [])],
    section,
    // The worktrees beside the primary checkouts. Those are left out
    // because every project has one, and a number on every line
    // would say nothing about where the work is. None while a listing
    // is loading or failed, since the rest's share alone would read as
    // the whole.
    branches:
      rowsDrawn || missing || unlisted !== null
        ? undefined
        : visible.filter((row) => !row.worktree.isPrimary).length,
    devices: deviceBadgesOf(peers),
    members: membersOf(peers),
  };
}

// What lists the projects as the tree does (projectListSections).
export type ProjectListArgs = Pick<
  BuildSidebarRowsArgs,
  | "items"
  | "order"
  | "hiddenPrefixes"
  | "allowAgentWorking"
  | "mirrors"
  | "localSides"
> & { byOwner: boolean };

// The list of projects' headers in its order, with no project's rows
// drawn and so no fold open.
export function projectHeaders({
  items,
  order,
  byOwner,
  ...forest
}: ProjectListArgs): ProjectListRow[] {
  const groups = sortedGroups(items, order);
  const file = groupFiler(
    { ...forest, groups, openShelves: NO_SHELVES, deviceBadges: new Map() },
    mirrorPairsOf(forest.mirrors),
  );
  return groups.map((group) =>
    projectHeader(group, file(group), {
      order,
      byOwner,
      expanded: false,
      folded: undefined,
    }),
  );
}

const NO_SHELVES: Record<GroupShelf, GroupKeySet> = {
  agentWorking: EMPTY,
  shelved: EMPTY,
  hidden: EMPTY,
};

type WorktreeRow = Extract<SidebarRow, { kind: "worktree" }>;

// The group's (device, project) pairs, in the order they were merged,
// one per device like the badges: a device that registered the same
// repo twice acts through its first registration.
function membersOf(items: readonly ForestItem[]): RemoteProjectMember[] {
  const members = new Map<string, RemoteProjectMember>();
  for (const { device, project } of items) {
    if (!members.has(device.deviceId)) {
      members.set(device.deviceId, {
        deviceId: device.deviceId,
        deviceLabel: device.label,
        deviceIcon: device.icon,
        project,
      });
    }
  }
  return [...members.values()];
}

// One badge per contributing device, first sighting wins the order (a
// device usually contributes one project slice here anyway).
function deviceBadgesOf(items: readonly ForestItem[]): SidebarDeviceBadge[] {
  const badges = new Map<string, SidebarDeviceBadge>();
  for (const { device } of items) {
    if (!badges.has(device.deviceId)) badges.set(device.deviceId, device);
  }
  return [...badges.values()];
}
