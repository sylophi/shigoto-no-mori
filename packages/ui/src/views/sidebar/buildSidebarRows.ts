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
  type Filed,
  NO_OWNER_KEY,
  ownerKeyOf,
  type ProjectGroupOrder,
} from "./projectGroupOrder.ts";
import {
  GROUP_SHELVES,
  type GroupShelf,
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
  localSides = new Map(),
  deviceBadges,
}: BuildSidebarRowsArgs): SidebarViewModel {
  const { peerRowsFolded, peerOfLocal } = mirrorPairsOf(mirrors);
  const mirrorBadgeFor = mirrorBadgeLookup(peerOfLocal, deviceBadges);
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
  const localRows = (
    trees: readonly Worktree[],
    pullRequests: Record<string, PullRequest> | undefined,
    shelf: GroupShelf | null,
  ): LocalRow[] =>
    trees.map((worktree) => ({
      kind: "worktree",
      key: worktreeRowKey(undefined, worktree.id),
      worktree,
      mirror: mirrorBadgeFor(worktree),
      mirrorWorktreeId: peerOfLocal.get(worktree.id)?.peerWorktreeId,
      pr: pullRequests?.[worktree.branch],
      stack: null,
      shelf,
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

  // One group per header: every local project with the peers' checkouts
  // of the same repo, then the repos only peers hold. A project is a
  // project wherever it is checked out, so both kinds sort together and
  // render through the same rows.
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

  // A run of rows per group, its header first (but for the open
  // project's, held over the rows instead), so the list's pinned and
  // owner sections move a project's worktrees with it.
  const chunks: SidebarRow[][] = [];
  let pinned: SidebarRow | undefined;
  // The header each row behind a shut fold stands behind, for
  // revealKey.
  const shutFoldRows = new Map<string, string>();
  const hide = (
    local: readonly Worktree[],
    peers: readonly RemoteRow[],
    foldKey: string,
  ) => {
    for (const worktree of local)
      shutFoldRows.set(worktreeRowKey(undefined, worktree.id), foldKey);
    for (const row of peers) shutFoldRows.set(row.key, foldKey);
  };
  // Every group is in the order, which was built over a superset of
  // these inputs. The fallback only keeps the comparator total.
  const rankOf = (group: ProjectGroup) =>
    order.groups.get(group.groupId) ?? order.groups.size;
  const sorted = groups.toSorted((a, b) => rankOf(a) - rankOf(b));
  const folderNames = new Map(
    [...order.filed].map(([section, byName]) => [section, [...byName.keys()]]),
  );
  // The tree draws one level: the open project on its own, or the list
  // of projects, a header each, and inline each one's rows under it.
  // (A repo registered twice here is two groups under one key, and
  // opens as both.)
  const open =
    inline === null ? sorted.filter((group) => group.groupKey === openKey) : [];
  const inProject = open.length > 0;
  for (const group of inProject ? open : sorted) {
    const { groupId, project, query } = group;
    const rows: SidebarRow[] = [];
    chunks.push(rows);
    // Inline, whether the project is folded to its header.
    const isFolded =
      inline === null ? undefined : inline.collapsed.has(groupId);
    const rowsDrawn = inProject || isFolded === false;
    // What the group lists, worked out the same way at both levels, so
    // the list's count is the rows the project draws once opened.
    // Peers' worktrees of this same repo sort in among the local rows
    // (sortWorktrees) -- and render on EVERY path below: a claimed
    // group that then skipped rendering (local listing still loading,
    // or errored) would vanish from the tree entirely, hiding the
    // peer's perfectly healthy worktrees behind a local-only failure.
    // Their shelved and hidden ones share the group's folds with the
    // local ones, so a device showing only peers' work (the web
    // client) can still reach them.
    const remoteVisible: RemoteRow[] = [];
    const remoteShelves = emptyShelves<RemoteRow>();
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
    const missing = project.pathExists === false;
    const section = sectionOf(project, byOwner);
    const header: SidebarRow = {
      kind: "project",
      key: `p:${groupId}`,
      groupId,
      groupKey: group.groupKey,
      project,
      local: group.local,
      expanded: inProject,
      folded: isFolded,
      pinned: order.pinned.has(group.groupKey),
      folder: order.folders.get(group.groupKey) ?? null,
      folders: folderNames.get(section) ?? [],
      section,
      // The worktrees beside the primary checkouts. Those are left out
      // because every project has one, and a number on every line
      // would say nothing about where the work is. None while this
      // machine's listing is loading or failed, since the peers' share
      // alone would read as the whole.
      branches:
        rowsDrawn || missing || unlisted !== null
          ? undefined
          : localVisible.filter((worktree) => !worktree.isPrimary).length +
            remoteVisible.filter((row) => !row.worktree.isPrimary).length,
      devices: deviceBadgesOf(group.remote),
      members: membersOf(group.remote),
    };
    // The open project's header stands over its rows rather than among
    // them. A repo registered twice opens as both its groups, and those
    // keep their headers in the rows, each over its own.
    if (inProject && open.length === 1) pinned = header;
    else rows.push(header);
    if (missing) continue;
    if (!rowsDrawn) {
      // A folded project's header stands in for its rows.
      if (isFolded) {
        hide(localVisible, remoteVisible, header.key);
        for (const shelf of GROUP_SHELVES)
          hide(localShelves[shelf], remoteShelves[shelf], header.key);
      }
      continue;
    }
    if (unlisted !== null) {
      rows.push({
        kind: unlisted,
        key: `${unlisted === "worktree-skeleton" ? "sk" : "err"}:${project.id}`,
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
      peers: RemoteRow[],
      shelf: GroupShelf | null,
    ): SidebarRow[] =>
      placeByStack(
        sortWorktrees(
          [...localRows(local, group.pullRequests, shelf), ...peers],
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
      peers: RemoteRow[],
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

  // The pinned projects lead the list, parted from the rest by a gap,
  // and the rest split by owner files the headers drawn above under
  // them.
  const drawn = inProject
    ? chunks.flat()
    : pinnedFirst(chunks, byOwner, order.owners, {
        filed: order.filed,
        shut: shutFolders,
        hide: (key, foldKey) => shutFoldRows.set(key, foldKey),
      });

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
  peers: RemoteRow[];
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

const isPinned = ([header]: SidebarRow[]) =>
  header?.kind === "project" && header.pinned;

// The list of projects' rows, a run per project, with the pinned ones
// first, the last of them marked for the gap under it when more follow
// and it is a header alone, then the rest, split by owner when
// `byOwner` says to, and by folder.
function pinnedFirst(
  chunks: SidebarRow[][],
  byOwner: BuildSidebarRowsArgs["byOwner"],
  owners: ProjectGroupOrder["owners"],
  folders: Folders,
): SidebarRow[] {
  const lead = chunks.filter(isPinned).flat();
  const rest = chunks.filter((chunk) => !isPinned(chunk));
  const after =
    byOwner === null
      ? folderRuns(rest, ALL_KEY, folders)
      : ownerSections(rest, owners, byOwner.shut, folders);
  const end = lead.at(-1);
  if (end?.kind === "project" && after.length > 0)
    lead[lead.length - 1] = { ...end, pinnedEnd: true };
  return [...lead, ...after];
}

// The list of projects' rows, a run per project, under a header per
// owner, the owners in `order` and labeled as it says. Projects with no
// owner trail the rest under a header of their own, as the order
// leaves them out. All of one owner (or none), there is nothing to tell
// apart, so the list stays one run with no header. A shut owner's rows
// are handed to `hide`, its header standing in for them.
function ownerSections(
  chunks: SidebarRow[][],
  order: ProjectGroupOrder["owners"],
  shut: ReadonlySet<string>,
  folders: Folders,
): SidebarRow[] {
  const sections = new Map<string, SidebarRow[][]>();
  for (const chunk of chunks) {
    const [header] = chunk;
    const key =
      header?.kind === "project" ? ownerKeyOf(header.project) : NO_OWNER_KEY;
    const section = sections.get(key);
    if (section) section.push(chunk);
    else sections.set(key, [chunk]);
  }
  const [only] = sections.keys();
  if (sections.size < 2) return folderRuns(chunks, only ?? ALL_KEY, folders);
  const rankOf = (key: string) => order.get(key)?.rank ?? order.size;
  const drawn: SidebarRow[] = [];
  for (const [ownerKey, section] of [...sections].toSorted(
    ([a], [b]) => rankOf(a) - rankOf(b),
  )) {
    const expanded = !shut.has(ownerKey);
    const headerKey = `o:${ownerKey}`;
    drawn.push({
      kind: "owner-header",
      key: headerKey,
      ownerKey,
      label: order.get(ownerKey)?.label ?? "No remote",
      count: section.length,
      expanded,
    });
    if (expanded) drawn.push(...folderRuns(section, ownerKey, folders));
    else for (const row of section.flat()) folders.hide(row.key, headerKey);
  }
  return drawn;
}

// The folders as the list draws them: each section's (filedFolders),
// the shut ones' fold keys, and where their rows are left out.
interface Folders {
  filed: Filed;
  shut: ReadonlySet<string>;
  hide: HideRow;
}

const sectionOf = (
  project: Project,
  byOwner: BuildSidebarRowsArgs["byOwner"],
) => (byOwner === null ? ALL_KEY : ownerKeyOf(project));

// A section's projects' rows: each folder's under a header of its own,
// set in under it, then the ones in no folder. A shut folder's rows are
// handed to `hide`, its header standing in for them.
function folderRuns(
  chunks: SidebarRow[][],
  section: string,
  { filed, shut, hide }: Folders,
): SidebarRow[] {
  const loose: SidebarRow[][] = [];
  const runs = new Map<string, SidebarRow[][]>();
  for (const chunk of chunks) {
    const [header] = chunk;
    const folder = header?.kind === "project" ? header.folder : null;
    if (folder === null) {
      loose.push(chunk);
      continue;
    }
    const run = runs.get(folder);
    if (run) run.push(chunk);
    else runs.set(folder, [chunk]);
  }
  const drawn: SidebarRow[] = [];
  for (const [name, groupKeys] of filed.get(section) ?? []) {
    const run = runs.get(name);
    if (run === undefined) continue;
    const foldKey = `${section}\n${name}`;
    const headerKey = `f:${foldKey}`;
    const expanded = !shut.has(foldKey);
    drawn.push({
      kind: "project-folder",
      key: headerKey,
      section,
      foldKey,
      name,
      groupKeys,
      count: run.length,
      expanded,
    });
    for (const row of run.flat())
      if (expanded) drawn.push({ ...row, nested: true });
      else hide(row.key, headerKey);
  }
  return [...drawn, ...loose.flat()];
}

// Files a row left out behind the row standing in for it (revealKey).
type HideRow = (key: string, foldKey: string) => void;

type LocalRow = Extract<SidebarRow, { kind: "worktree" }>;
type RemoteRow = Extract<SidebarRow, { kind: "remote-worktree" }>;

function remoteWorktreeRows(
  item: RemoteForestItem,
  groupId: string,
  hiddenPrefixes: readonly string[],
  allowAgentWorking: boolean,
  folded: (peerKey: string, shelf: GroupShelf | null) => boolean,
): RemoteRow[] {
  const rows: RemoteRow[] = [];
  for (const worktree of item.worktrees) {
    const key = remoteWorktreeKey(item.deviceId, worktree.id);
    const shelf = groupShelfOf(worktree, hiddenPrefixes, allowAgentWorking);
    // The local row of a mirrored pair stands for both copies.
    if (folded(key, shelf)) continue;
    rows.push({
      kind: "remote-worktree",
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
