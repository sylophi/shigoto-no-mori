import {
  placeByStack,
  pullRequestStackFor,
  trunkOf,
} from "@shigomori/contracts/pullRequestStack";
import { groupPrefixOf } from "@shigomori/contracts/sharedSettings";
import {
  deviceBadgeOf,
  groupShelfOf,
  type LocalSide,
  mirrorBadgeLookup,
  mirrorPairsOf,
  type MirrorLink,
  type ProjectPullRequestQueries,
  type ProjectWorktreeQueries,
  projectGroupKey,
  type RemoteForestItem,
  remoteGroupId,
  remoteWorktreeKey,
  worktreeRowKey,
} from "../../lib/forest.ts";
import type {
  Project,
  PullRequest,
  Worktree,
  WorktreeSortMode,
} from "@shigomori/contracts/schemas";
import type { SidebarDeviceBadge } from "./DeviceBadgeView.tsx";
import {
  ALL_KEY,
  claimRemote,
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

// A set of group ids as the builder asks it: only whether one is in.
// The shell keeps the open project and the shelf reveals by group key
// (projectGroupKey), so it hands a view over those rather than the ids
// spelled out.
export type GroupIdSet = Pick<ReadonlySet<string>, "has">;

export interface BuildSidebarRowsArgs {
  projects: readonly Project[];
  // Both positionally aligned with `projects`. The PR maps are what
  // gathers a stack's rows together.
  worktreeQueries: ProjectWorktreeQueries;
  pullRequestQueries: ProjectPullRequestQueries;
  // The group key (projectGroupKey) of the project the tree is inside,
  // null on the list of projects. A key no group here goes by (the
  // device filter narrowed the project away, or it was removed) reads
  // as the list rather than as an empty tree. Unread while `inline`.
  openKey: string | null;
  // Lists every project's worktrees under its header on the list of
  // projects, the groups in `collapsed` drawn as their header alone,
  // rather than one project at a time. Null steps into projects.
  inline: { collapsed: GroupIdSet } | null;
  // Where each group sits (projectGroupOrder), decided over every
  // device's projects so the device filter never reorders the groups.
  order: ProjectGroupOrder;
  // How a project's worktrees are ordered, by group key
  // (useWorktreeSorts).
  worktreeSort: (groupKey: string) => WorktreeSortMode;
  // The groups whose shelf is open, per shelf.
  openShelves: Record<GroupShelf, GroupIdSet>;
  // Worktrees starting with one of these fold away like shelved ones.
  hiddenPrefixes: readonly string[];
  // Whether a working agent session shelves its worktree (isAgentWorking).
  allowAgentWorking: boolean;
  // Gathers the open project's worktrees starting with one of
  // `prefixes` under a header per prefix (groupPrefixOf), those `shut`
  // names drawn as their header alone. Null groups nothing.
  byPrefix: {
    prefixes: readonly string[];
    shut: (groupId: string, prefix: string) => boolean;
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
  // Peer devices' forests, merged into the tree: a remote project
  // sharing a local project's repo identity contributes its worktrees
  // to that group (marked per row), the rest gather under project
  // headers of their own.
  remote: RemoteForestItem[];
  // This device's mirrored pairs (useMirrorLinks). A pair is one
  // worktree on two machines, so the peer's row folds into the local
  // row (see mirrorPairsOf).
  mirrors: readonly MirrorLink[];
  // This device's sides of pairs whose own projects the build doesn't
  // list (localSidesWith), by worktree id: each is listed among its
  // peer's rows, and the peer's row folds into it as into a listed
  // local row, so a pair reads under the peer's filter as it does
  // under every device.
  localSides?: ReadonlyMap<string, LocalSide>;
  // Every peer's badge off the device registry (useDeviceBadges),
  // whether or not its rows are in `remote`: the device filter narrows
  // the rows, and a local row's mirror still names its peer while the
  // peer's own rows are hidden.
  deviceBadges: ReadonlyMap<string, SidebarDeviceBadge>;
}

// Flattens `projects` plus their per-project worktree queries into the
// SidebarRow list the virtualizer renders. A plain function, not a hook:
// the queries are subscribed once by the Sidebar and handed to whichever
// builder the active view needs, so flipping views doesn't tear the
// subscriptions down and re-probe git for every project.
//
// No memo, deliberately. The result is O(rows) to rebuild and the inputs
// change whenever anything on screen does, so a cache here would need a
// deep fingerprint to stay correct and would save nothing.
export function buildSidebarRows({
  projects,
  worktreeQueries,
  pullRequestQueries,
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
  remote,
  mirrors,
  localSides,
  deviceBadges,
}: BuildSidebarRowsArgs): SidebarViewModel {
  const { peerRowsFolded, peerOfLocal } = mirrorPairsOf(mirrors);
  const mirrorBadgeFor = mirrorBadgeLookup(peerOfLocal, deviceBadges);
  const localRows = (
    trees: readonly Worktree[],
    pullRequests: Record<string, PullRequest> | undefined,
    shelf: GroupShelf | null,
    groupId: string,
  ): WorktreeRow[] =>
    trees.map((worktree) => ({
      kind: "worktree",
      key: worktreeRowKey(undefined, worktree.id),
      worktree,
      mirror: mirrorBadgeFor(worktree),
      mirrorWorktreeId: peerOfLocal.get(worktree.id)?.peerWorktreeId,
      pr: pullRequests?.[worktree.branch],
      stack: null,
      shelf,
      groupId,
    }));

  if (arrangeMode) {
    const rows: SidebarRow[] = projects.map((project) => ({
      kind: "project",
      key: `p:${project.id}`,
      groupId: project.id,
      groupKey: projectGroupKey(project, undefined),
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

  const file = groupFiler(
    {
      projects,
      worktreeQueries,
      openShelves,
      hiddenPrefixes,
      allowAgentWorking,
      localSides,
    },
    peerRowsFolded,
  );
  // A run of rows per group under its header, so the list's pinned and
  // owner sections move a project's worktrees with it.
  const chunks: Chunk[] = [];
  let pinned: SidebarRow | undefined;
  // The header each row behind a shut fold stands behind, for
  // revealKey.
  const shutFoldRows = new Map<string, string>();
  const hide = (
    local: readonly Worktree[],
    peers: readonly WorktreeRow[],
    foldKey: string,
  ) => {
    for (const worktree of local)
      shutFoldRows.set(worktreeRowKey(undefined, worktree.id), foldKey);
    for (const row of peers) shutFoldRows.set(row.key, foldKey);
  };
  const sorted = sortedGroups({
    projects,
    worktreeQueries,
    pullRequestQueries,
    remote,
    order,
  });
  // The tree draws one level: the open project on its own, or the list
  // of projects, a header each, and inline each one's rows under it.
  // (A repo registered twice here is two groups under one key, and
  // opens as both.)
  const open =
    inline === null ? sorted.filter((group) => group.groupKey === openKey) : [];
  const inProject = open.length > 0;
  for (const group of inProject ? open : sorted) {
    const { groupId, project, query } = group;
    // Inline, whether the project is folded to its header.
    const isFolded =
      inline === null ? undefined : inline.collapsed.has(groupId);
    const rowsDrawn = inProject || isFolded === false;
    const filed = file(group);
    const { localVisible, localShelves, remoteVisible, remoteShelves } = filed;
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
    if (project.pathExists === false) continue;
    if (!rowsDrawn) {
      // A folded project's header stands in for its rows.
      if (isFolded) {
        hide(localVisible, remoteVisible, header.key);
        for (const shelf of GROUP_SHELVES)
          hide(localShelves[shelf], remoteShelves[shelf], header.key);
      }
      continue;
    }
    if (filed.unlisted !== null) {
      rows.push({
        kind: filed.unlisted,
        key: `${filed.unlisted === "worktree-skeleton" ? "sk" : "err"}:${project.id}`,
        projectId: project.id,
      });
    }
    // In the project's sort, then a stack's rows sit together on a
    // rail, top layer first, wherever its layers are checked out:
    // gathered at its first layer's place. The trunk comes off
    // whichever listing the group has.
    const trunk = trunkOf(query?.data) ?? trunkOf(group.remote[0]?.worktrees);
    const placed = (
      local: readonly Worktree[],
      peers: WorktreeRow[],
      shelf: GroupShelf | null,
    ): SidebarRow[] =>
      placeByStack(
        sortWorktrees(
          [...localRows(local, group.pullRequests, shelf, groupId), ...peers],
          worktreeSort(group.groupKey),
          (row) => row.worktree,
        ),
        (row) => row.worktree.branch,
        group.pullRequests,
        trunk,
      ).map(({ item, position, rail }) => {
        // The rows were built for this call, so they are ours to fill in.
        item.stack = position;
        item.stackRail = rail;
        return item;
      });
    // A fold's rows: placed when it is open, else left out with the
    // fold's header standing in for each.
    const foldRows = (
      local: Worktree[],
      peers: WorktreeRow[],
      shelf: GroupShelf | null,
      shown: boolean,
      foldKey: string,
    ): SidebarRow[] => {
      if (shown) return placed(local, peers, shelf);
      hide(local, peers, foldKey);
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
      group.pullRequests && !worktree.detached
        ? pullRequestStackFor(group.pullRequests, worktree.branch, trunk)
        : null;
    const stackPrefix = new Map<
      string,
      { index: number; prefix: string | null }
    >();
    for (const worktree of [
      ...localVisible,
      ...remoteVisible.map((row) => row.worktree),
    ]) {
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
    const rest: Bucket = { local: [], peers: [] };
    const grouped = new Map<string, Bucket>();
    const bucketOf = (worktree: Worktree): Bucket => {
      const bottom = stackOf(worktree)?.entries[0]?.branch;
      const prefix =
        bottom === undefined
          ? groupPrefixOf(worktree, prefixes)
          : (stackPrefix.get(bottom)?.prefix ?? null);
      if (prefix === null) return rest;
      const bucket = grouped.get(prefix) ?? { local: [], peers: [] };
      grouped.set(prefix, bucket);
      return bucket;
    };
    for (const worktree of localVisible)
      bucketOf(worktree).local.push(worktree);
    for (const row of remoteVisible) bucketOf(row.worktree).peers.push(row);
    rows.push(...placed(rest.local, rest.peers, null));
    for (const prefix of prefixes) {
      const bucket = grouped.get(prefix);
      if (!bucket) continue;
      const groupOpen = !shut(groupId, prefix);
      const headerKey = `g:${groupId}:${prefix}`;
      rows.push(
        {
          kind: "worktree-group",
          key: headerKey,
          groupId,
          prefix,
          count: bucket.local.length + bucket.peers.length,
          expanded: groupOpen,
        },
        ...foldRows(bucket.local, bucket.peers, null, groupOpen, headerKey),
      );
    }
    for (const shelf of GROUP_SHELVES) {
      const count = localShelves[shelf].length + remoteShelves[shelf].length;
      if (count === 0) continue;
      const shelfOpen = openShelves[shelf].has(groupId);
      const shelfKey = `${shelf}:${groupId}`;
      rows.push(
        {
          kind: "group-shelf",
          key: shelfKey,
          groupId,
          shelf,
          count,
          expanded: shelfOpen,
        },
        ...foldRows(
          localShelves[shelf],
          remoteShelves[shelf],
          shelf,
          shelfOpen,
          shelfKey,
        ),
      );
    }
  }

  const drawn = inProject
    ? chunks.flatMap(({ header, rows }) => (pinned ? rows : [header, ...rows]))
    : listRows(
        chunks,
        order,
        byOwner?.shut ?? NONE_SHUT,
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
      const shown = (key: string): string | undefined => {
        if (drawn.some((r) => r.key === key)) return key;
        const foldKey = shutFoldRows.get(key);
        return foldKey === undefined ? undefined : shown(foldKey);
      };
      // A peer's row is device-qualified (remoteWorktreeRows). It
      // is absent while its listing is in flight or the tree is not
      // inside its project, which reveals nothing: the shell opens the
      // project of the worktree on screen, and the row is revealed
      // once it draws. Settling for the header would mark the reveal
      // done before then.
      if (deviceId !== undefined) {
        const key = remoteWorktreeKey(deviceId, worktreeId);
        // A peer's worktree folded into its local mirror: reveal that.
        const local = peerRowsFolded.get(key);
        return (
          shown(key) ??
          (local === undefined
            ? undefined
            : shown(worktreeRowKey(undefined, local))) ??
          null
        );
      }
      return shown(worktreeRowKey(undefined, worktreeId)) ?? null;
    },
  };
}

// One fold's rows, before they are placed.
interface Bucket {
  local: Worktree[];
  peers: WorktreeRow[];
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

// What one header leads. `query` is this machine's worktree listing,
// which a peer-only group has none of.
interface ProjectGroup {
  groupId: string;
  // What the shell keeps the open project by (projectGroupKey).
  groupKey: string;
  project: Project;
  query: ProjectWorktreeQueries[number] | undefined;
  // The repo's branch -> PR map, off whichever checkout the group has.
  pullRequests: Record<string, PullRequest> | undefined;
  local: boolean;
  remote: RemoteForestItem[];
}

// A group's header and, when they are drawn, the rows under it.
interface Chunk {
  header: ProjectListRow;
  rows: SidebarRow[];
}

const NONE_SHUT: ReadonlySet<string> = new Set();

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

// One group per header: every local project with the peers' checkouts
// of the same repo, then the repos only peers hold, where `order` puts
// them. A project is a project wherever it is checked out, so both
// kinds sort together and render through the same rows.
function sortedGroups({
  projects,
  worktreeQueries,
  pullRequestQueries,
  remote,
  order,
}: Pick<
  BuildSidebarRowsArgs,
  "projects" | "worktreeQueries" | "pullRequestQueries" | "remote" | "order"
>): ProjectGroup[] {
  const { claimed, peerOnly } = claimRemote(projects, remote);
  const groups: ProjectGroup[] = projects.map((project, i) => ({
    groupId: project.id,
    groupKey: projectGroupKey(project, undefined),
    project,
    query: worktreeQueries[i],
    pullRequests: pullRequestQueries[i]?.data,
    local: true,
    remote: claimed[i] ?? [],
  }));
  // The same repo on several devices reads as one project (the per-row
  // device marker tells them apart), led by the first device's
  // checkout.
  for (const [groupKey, items] of peerOnly) {
    const [first] = items;
    if (!first) continue;
    groups.push({
      groupId: remoteGroupId(groupKey),
      groupKey,
      project: first.project,
      query: undefined,
      // One repo has one set of PRs wherever it is checked out, so the
      // first peer's map serves the group.
      pullRequests: first.pullRequests,
      local: false,
      remote: items,
    });
  }
  // Every group is in the order, which was built over a superset of
  // these inputs. The fallback only keeps the comparator total.
  const rankOf = (group: ProjectGroup) =>
    order.groups.get(group.groupId) ?? order.groups.size;
  return groups.toSorted((a, b) => rankOf(a) - rankOf(b));
}

// What a group lists, the open rows and each fold's, this machine's and
// the peers' apart. Worked out the same way at both levels, so the
// list's count is the rows the project draws once opened. `unlisted`
// is the row standing in for this machine's listing while it loads or
// after it failed.
interface FiledGroup {
  localVisible: Worktree[];
  localShelves: Record<GroupShelf, Worktree[]>;
  remoteVisible: WorktreeRow[];
  remoteShelves: Record<GroupShelf, WorktreeRow[]>;
  unlisted: "worktree-skeleton" | "worktree-error" | null;
}

function groupFiler(
  {
    projects,
    worktreeQueries,
    openShelves,
    hiddenPrefixes,
    allowAgentWorking,
    localSides = new Map(),
  }: Pick<
    BuildSidebarRowsArgs,
    | "projects"
    | "worktreeQueries"
    | "openShelves"
    | "hiddenPrefixes"
    | "allowAgentWorking"
    | "localSides"
  >,
  peerRowsFolded: ReadonlyMap<string, string>,
): (group: ProjectGroup) => FiledGroup {
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
  projects.forEach((project, i) => {
    if (project.pathExists === false) return;
    const query = worktreeQueries[i];
    // A failed refetch keeps its last data, but the group draws the
    // error row instead of it.
    if (!query || query.error) return;
    for (const worktree of query.data ?? []) {
      const shelf = groupShelfOf(worktree, hiddenPrefixes, allowAgentWorking);
      listedLocal.set(worktree.id, {
        groupId: project.id,
        shelf,
        shown: shelf === null || openShelves[shelf].has(project.id),
      });
    }
  });
  const foldedInto = (
    peerKey: string,
    shelf: GroupShelf | null,
    groupId: string,
  ): boolean => {
    const local = peerRowsFolded.get(peerKey);
    const listed = local === undefined ? undefined : listedLocal.get(local);
    if (!listed) return false;
    return (
      listed.shown ||
      (shelf !== null && listed.shelf === shelf && listed.groupId === groupId)
    );
  };
  return (group) => {
    const { groupId, query } = group;
    // Peers' worktrees of this same repo sort in among the local rows
    // (sortWorktrees) -- and render on EVERY path below: a claimed
    // group that then skipped rendering (local listing still loading,
    // or errored) would vanish from the tree entirely, hiding the
    // peer's perfectly healthy worktrees behind a local-only failure.
    // Their shelved and hidden ones share the group's folds with the
    // local ones, so a device showing only peers' work (the web
    // client) can still reach them.
    const remoteVisible: WorktreeRow[] = [];
    const remoteShelves = emptyShelves<WorktreeRow>();
    const localVisible: Worktree[] = [];
    const localShelves = emptyShelves<Worktree>();
    const fileLocal = (worktree: Worktree) => {
      const shelf = groupShelfOf(worktree, hiddenPrefixes, allowAgentWorking);
      (shelf === null ? localVisible : localShelves[shelf]).push(worktree);
      return shelf;
    };
    const folded = (peerKey: string, shelf: GroupShelf | null) =>
      foldedInto(peerKey, shelf, groupId);
    for (const item of group.remote) {
      // This device's side of a pair with the peer, filed among the
      // group's local rows and listed for the peer's row to fold into.
      for (const worktree of item.worktrees) {
        const local = peerRowsFolded.get(
          remoteWorktreeKey(item.deviceId, worktree.id),
        );
        const side = local === undefined ? undefined : localSides.get(local);
        if (side === undefined) continue;
        const shelf = fileLocal(side.worktree);
        listedLocal.set(side.worktree.id, {
          groupId,
          shelf,
          shown: shelf === null || openShelves[shelf].has(groupId),
        });
      }
      const peerRows = remoteWorktreeRows(
        item,
        groupId,
        hiddenPrefixes,
        allowAgentWorking,
        folded,
      );
      for (const row of peerRows) {
        const { shelf } = row;
        (shelf === null ? remoteVisible : remoteShelves[shelf]).push(row);
      }
    }
    const unlisted = query?.isLoading
      ? "worktree-skeleton"
      : query?.error
        ? "worktree-error"
        : null;
    if (query && unlisted === null) {
      for (const worktree of query.data ?? []) {
        fileLocal(worktree);
      }
    }
    return {
      localVisible,
      localShelves,
      remoteVisible,
      remoteShelves,
      unlisted,
    };
  };
}

// A group's header: on the list of projects, or `expanded` over the
// open project. `folded` is the inline list's (the project row's).
function projectHeader(
  group: ProjectGroup,
  { localVisible, remoteVisible, unlisted }: FiledGroup,
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
  const { groupId, project } = group;
  const section = byOwner ? ownerKeyOf(project) : ALL_KEY;
  return {
    kind: "project",
    key: `p:${groupId}`,
    groupId,
    groupKey: group.groupKey,
    project,
    local: group.local,
    expanded,
    folded,
    pinned: order.pinned.has(group.groupKey),
    folder: order.folders.get(group.groupKey) ?? null,
    folders: [...(order.filed.get(section)?.keys() ?? [])],
    section,
    // The worktrees beside the primary checkouts. Those are left out
    // because every project has one, and a number on every line
    // would say nothing about where the work is. None while this
    // machine's listing is loading or failed, since the peers' share
    // alone would read as the whole.
    branches:
      expanded ||
      folded === false ||
      project.pathExists === false ||
      unlisted !== null
        ? undefined
        : localVisible.filter((worktree) => !worktree.isPrimary).length +
          remoteVisible.filter((row) => !row.worktree.isPrimary).length,
    devices: deviceBadgesOf(group.remote),
    members: membersOf(group.remote),
  };
}

// What lists the projects as the tree does (projectListSections).
export type ProjectListArgs = Pick<
  BuildSidebarRowsArgs,
  | "projects"
  | "worktreeQueries"
  | "pullRequestQueries"
  | "order"
  | "hiddenPrefixes"
  | "allowAgentWorking"
  | "remote"
  | "mirrors"
  | "localSides"
> & { byOwner: boolean };

// The list of projects' headers in its order, with no project's rows
// drawn and so no fold open.
export function projectHeaders({
  byOwner,
  mirrors,
  ...forest
}: ProjectListArgs): ProjectListRow[] {
  const file = groupFiler(
    { ...forest, openShelves: NO_SHELVES },
    mirrorPairsOf(mirrors).peerRowsFolded,
  );
  return sortedGroups(forest).map((group) =>
    projectHeader(group, file(group), {
      order: forest.order,
      byOwner,
      expanded: false,
      folded: undefined,
    }),
  );
}

const NO_SHELVES: Record<GroupShelf, GroupIdSet> = {
  agentWorking: NONE_SHUT,
  shelved: NONE_SHUT,
  hidden: NONE_SHUT,
};

type WorktreeRow = Extract<SidebarRow, { kind: "worktree" }>;

function remoteWorktreeRows(
  item: RemoteForestItem,
  groupId: string,
  hiddenPrefixes: readonly string[],
  allowAgentWorking: boolean,
  folded: (peerKey: string, shelf: GroupShelf | null) => boolean,
): WorktreeRow[] {
  const rows: WorktreeRow[] = [];
  for (const worktree of item.worktrees) {
    const key = remoteWorktreeKey(item.deviceId, worktree.id);
    const shelf = groupShelfOf(worktree, hiddenPrefixes, allowAgentWorking);
    // The local row of a mirrored pair stands for both copies.
    if (folded(key, shelf)) continue;
    rows.push({
      kind: "worktree",
      key,
      worktree,
      device: deviceBadgeOf(item),
      pr: item.pullRequests[worktree.branch],
      stack: null,
      shelf,
      groupId,
    });
  }
  return rows;
}

// The group's (device, project) pairs, in the order they were merged,
// one per device like the badges: a device that registered the same
// repo twice acts through its first registration.
function membersOf(items: readonly RemoteForestItem[]): RemoteProjectMember[] {
  const members = new Map<string, RemoteProjectMember>();
  for (const item of items) {
    if (!members.has(item.deviceId)) {
      members.set(item.deviceId, {
        deviceId: item.deviceId,
        deviceLabel: item.deviceLabel,
        deviceIcon: item.deviceIcon,
        project: item.project,
      });
    }
  }
  return [...members.values()];
}

// One badge per contributing device, first sighting wins the order (a
// device usually contributes one project slice here anyway).
function deviceBadgesOf(
  items: readonly RemoteForestItem[],
): SidebarDeviceBadge[] {
  const badges = new Map<string, SidebarDeviceBadge>();
  for (const item of items) {
    if (!badges.has(item.deviceId)) {
      badges.set(item.deviceId, deviceBadgeOf(item));
    }
  }
  return [...badges.values()];
}
