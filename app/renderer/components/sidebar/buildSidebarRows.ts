import {
  placeByStack,
  pullRequestStackFor,
  trunkOf,
} from "@shared/pullRequestStack";
import { MACHINE_FALLBACK_ICON } from "@shared/account/deviceIcon";
import { peerProjectKey } from "@shared/schemas/config";
import { groupPrefixOf, isHiddenByPrefix } from "@shared/sharedSettings";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { MirrorLink } from "@/hooks/remote/useMirrors";
import type { ProjectWorktreeQueries } from "@/hooks/worktrees/useWorktrees";
import type { ProjectPullRequestQueries } from "@/hooks/projects/useProjectPullRequests";
import type {
  Project,
  ProjectSortMode,
  PullRequest,
  Worktree,
  WorktreeSortMode,
} from "@shared/schemas";
import type { SidebarDeviceBadge } from "./DeviceBadge";
import {
  GROUP_SHELVES,
  type GroupShelf,
  type RemoteProjectMember,
  type SidebarRow,
  type SidebarViewModel,
} from "./sidebarRow";
import { sortByProject } from "@/lib/sortProjects";
import { sortWorktrees } from "@/lib/sortWorktrees";

// A set of group ids as the builder asks it: only whether one is in.
// The shell keeps the open project and the shelf reveals by group key
// (projectGroupKey), so it hands a view over those rather than the ids
// spelled out.
export type GroupIdSet = Pick<ReadonlySet<string>, "has">;

interface BuildSidebarRowsArgs {
  projects: readonly Project[];
  // Both positionally aligned with `projects`. The PR maps are what
  // gathers a stack's rows together.
  worktreeQueries: ProjectWorktreeQueries;
  pullRequestQueries: ProjectPullRequestQueries;
  // The group key (projectGroupKey) of the project the tree is inside,
  // null on the list of projects. A key no group here goes by (the
  // device filter narrowed the project away, or it was removed) reads
  // as the list rather than as an empty tree.
  openKey: string | null;
  // Where each group sits (projectGroupOrder), decided over every
  // device's projects so the device filter never reorders the groups.
  order: ProjectGroupOrder;
  // How the open project's worktrees are ordered (useWorktreeSort).
  worktreeSort: WorktreeSortMode;
  // The groups whose shelf is open, per shelf.
  openShelves: Record<GroupShelf, GroupIdSet>;
  // Worktrees starting with one of these fold away like shelved ones.
  hiddenPrefixes: readonly string[];
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
  // their header alone. Null lists the projects as one run, and so
  // does a list with a single owner, which a header would only repeat.
  byOwner: { shut: ReadonlySet<string> } | null;
  // Peer devices' forests, merged into the tree: a remote project
  // sharing a local project's repo identity contributes its worktrees
  // to that group (marked per row), the rest gather under project
  // headers of their own.
  remote: RemoteForestItem[];
  // This device's mirrored pairs (useMirrorLinks). A pair is one
  // worktree on two machines, so the peer's row folds into the local
  // row (see mirrorPairsOf).
  mirrors: readonly MirrorLink[];
  // Every peer's badge off the device registry (useDeviceBadges),
  // whether or not its rows are in `remote`: the device filter narrows
  // the rows, and a local row's mirror still names its peer while the
  // peer's own rows are hidden.
  deviceBadges: ReadonlyMap<string, SidebarDeviceBadge>;
}

// The pairs as the builders look them up: the local worktree each
// peer row (device, worktree) folds into, and the pair each local
// worktree is in.
export function mirrorPairsOf(mirrors: readonly MirrorLink[]): {
  peerRowsFolded: Map<string, string>;
  peerOfLocal: Map<string, MirrorLink>;
} {
  const peerRowsFolded = new Map<string, string>();
  const peerOfLocal = new Map<string, MirrorLink>();
  for (const link of mirrors) {
    peerRowsFolded.set(
      remoteWorktreeKey(link.peerDeviceId, link.peerWorktreeId),
      link.localWorktreeId,
    );
    peerOfLocal.set(link.localWorktreeId, link);
  }
  return { peerRowsFolded, peerOfLocal };
}

// The badge a local row wears for the peer it is mirrored with: the
// peer's own when the registry knows it (its label and tone), else
// unnamed. Shared by both builders so a pair reads the same in each.
export function mirrorBadgeLookup(
  peerOfLocal: ReadonlyMap<string, MirrorLink>,
  deviceBadges: ReadonlyMap<string, SidebarDeviceBadge>,
): (worktree: Worktree) => SidebarDeviceBadge | undefined {
  return (worktree) => {
    const peer = peerOfLocal.get(worktree.id)?.peerDeviceId;
    if (peer === undefined) return undefined;
    return (
      deviceBadges.get(peer) ?? {
        deviceId: peer,
        label: "another device",
        icon: MACHINE_FALLBACK_ICON,
        tone: "slate",
        reachable: false,
      }
    );
  };
}

// Which fold a worktree sits behind in its group, if any. Shelving is
// the user's own call, so it outranks the prefixes. The inbox files by
// the same rule.
export function groupShelfOf(
  worktree: Worktree,
  prefixes: readonly string[],
): GroupShelf | null {
  if (worktree.shelved) return "shelved";
  return isHiddenByPrefix(worktree, prefixes) ? "hidden" : null;
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
  order,
  worktreeSort,
  openShelves,
  hiddenPrefixes,
  byPrefix,
  arrangeMode,
  byOwner,
  remote,
  mirrors,
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
    for (const worktree of (query.data ?? []) as readonly Worktree[]) {
      const shelf = groupShelfOf(worktree, hiddenPrefixes);
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

  const rows: SidebarRow[] = [];
  let pinned: SidebarRow | undefined;
  // The toggle (or group header) each row behind a shut fold stands
  // behind, for revealKey.
  const shutFoldRows = new Map<string, string>();
  // Every group is in the order, which was built over a superset of
  // these inputs. The fallback only keeps the comparator total.
  const rankOf = (group: ProjectGroup) =>
    order.groups.get(group.groupId) ?? order.groups.size;
  const sorted = groups.toSorted((a, b) => rankOf(a) - rankOf(b));
  // The tree draws one level: the open project on its own, or the list
  // of projects, a header each. (A repo registered twice here is two
  // groups under one key, and opens as both.)
  const open = sorted.filter((group) => group.groupKey === openKey);
  const inProject = open.length > 0;
  for (const group of inProject ? open : sorted) {
    const { groupId, project, query } = group;
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
    const folded = (peerKey: string, shelf: GroupShelf | null) =>
      foldedInto(peerKey, shelf, groupId);
    for (const item of group.remote) {
      const peerRows = remoteWorktreeRows(
        item,
        groupId,
        hiddenPrefixes,
        folded,
      );
      for (const row of peerRows) {
        const { shelf } = row;
        (shelf === null ? remoteVisible : remoteShelves[shelf]).push(row);
      }
    }
    const localVisible: Worktree[] = [];
    const localShelves = emptyShelves<Worktree>();
    const unlisted = query?.isLoading
      ? "worktree-skeleton"
      : query?.error
        ? "worktree-error"
        : null;
    if (query && unlisted === null) {
      for (const worktree of (query.data ?? []) as readonly Worktree[]) {
        const shelf = groupShelfOf(worktree, hiddenPrefixes);
        (shelf === null ? localVisible : localShelves[shelf]).push(worktree);
      }
    }
    const missing = project.pathExists === false;
    const header: SidebarRow = {
      kind: "project",
      key: `p:${groupId}`,
      groupId,
      groupKey: group.groupKey,
      project,
      local: group.local,
      expanded: inProject,
      // The worktrees beside the primary checkouts. Those are left out
      // because every project has one, and a number on every line
      // would say nothing about where the work is. None while this
      // machine's listing is loading or failed, since the peers' share
      // alone would read as the whole.
      branches:
        inProject || missing || unlisted !== null
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
    if (missing || !inProject) continue;
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
    const trunk =
      trunkOf(query?.data as readonly Worktree[] | undefined) ??
      trunkOf(group.remote[0]?.worktrees);
    const placed = (
      local: readonly Worktree[],
      peers: RemoteRow[],
      shelf: GroupShelf | null,
    ): SidebarRow[] =>
      placeByStack(
        sortWorktrees(
          [...localRows(local, group.pullRequests, shelf), ...peers],
          worktreeSort,
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
    // fold's own row (its toggle or header) standing in for each.
    const foldRows = (
      local: Worktree[],
      peers: RemoteRow[],
      shelf: GroupShelf | null,
      shown: boolean,
      foldKey: string,
    ): SidebarRow[] => {
      if (shown) return placed(local, peers, shelf);
      for (const worktree of local) {
        shutFoldRows.set(worktreeRowKey(undefined, worktree.id), foldKey);
      }
      for (const row of peers) shutFoldRows.set(row.key, foldKey);
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
      const toggleKey = `${shelf}:${groupId}`;
      rows.push(
        ...foldRows(
          localShelves[shelf],
          remoteShelves[shelf],
          shelf,
          shelfOpen,
          toggleKey,
        ),
      );
      // Always anchored at the bottom of the project's section:
      // "N shelved" reveals, "Hide shelved" collapses (and the same
      // for hidden).
      rows.push({
        kind: "shelved-toggle",
        key: toggleKey,
        groupId,
        shelf,
        count,
        expanded: shelfOpen,
      });
    }
  }

  // The list split by owner files the headers drawn above under them.
  const drawn =
    inProject || byOwner === null
      ? rows
      : ownerSections(rows, order.owners, byOwner.shut);

  return {
    rows: drawn,
    pinned,
    level: inProject ? openKey : null,
    // Every project renders a header, so "no rows" here only ever means
    // "no projects", which the shell already has its own answer for.
    emptyMessage: null,
    revealKey: (_projectId, worktreeId, deviceId) => {
      // A row behind a shut shelved or hidden fold, or a shut group:
      // its toggle or header stands in for it.
      const shown = (key: string) =>
        drawn.some((r) => r.key === key) ? key : shutFoldRows.get(key);
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

// Who a project belongs to, off its remote's `host/owner/repo`: the
// org or user account, keyed by host too (one name on two hosts is two
// owners) and case-folded (hosts treat owner names that way). The host
// is left off the label for github.com, where nearly every remote is.
// Null when the project has no network remote, or its path has no
// owner segment.
function ownerOf(project: Project): { key: string; label: string } | null {
  const [host, owner, ...repo] = project.remote?.split("/") ?? [];
  if (!host || !owner || repo.length === 0) return null;
  return {
    key: `${host}/${owner}`.toLowerCase(),
    label: host === "github.com" ? owner : `${host}/${owner}`,
  };
}

// The list of projects' rows under a header per owner, the owners in
// `order`. Projects with no owner trail the rest under a header of
// their own, as the order leaves them out. All of one owner (or none),
// there is nothing to tell apart, so the list stays one run with no
// header.
function ownerSections(
  rows: SidebarRow[],
  order: ReadonlyMap<string, number>,
  shut: ReadonlySet<string>,
): SidebarRow[] {
  const sections = new Map<string, { label: string; rows: SidebarRow[] }>();
  for (const row of rows) {
    const owner = row.kind === "project" ? ownerOf(row.project) : null;
    const key = owner?.key ?? NO_OWNER_KEY;
    const section = sections.get(key);
    if (section) section.rows.push(row);
    else sections.set(key, { label: owner?.label ?? "No remote", rows: [row] });
  }
  if (sections.size < 2) return rows;
  const rankOf = (key: string) => order.get(key) ?? order.size;
  const drawn: SidebarRow[] = [];
  for (const [ownerKey, section] of [...sections].toSorted(
    ([a], [b]) => rankOf(a) - rankOf(b),
  )) {
    const expanded = !shut.has(ownerKey);
    drawn.push({
      kind: "owner-header",
      key: `o:${ownerKey}`,
      ownerKey,
      label: section.label,
      count: section.rows.length,
      expanded,
    });
    if (expanded) drawn.push(...section.rows);
  }
  return drawn;
}

// The section of the projects with no owner. Not a valid owner key
// (those always hold a slash), so no owner can take it.
const NO_OWNER_KEY = "none";

// Whether a local project takes the peers' checkouts of its repo.
// Claimed by identity even while still loading, so the project's
// remote worktrees stay under it instead of reappearing as a duplicate
// peer-only group. A missing local project
// claims nothing: its remote counterpart is alive and belongs under
// its own header.
const claimsPeers = (
  project: Project,
): project is Project & { identity: string } =>
  project.pathExists !== false && project.identity != null;

// The key a group goes by: what the peers' checkouts are grouped
// under, and what the shell keeps the open project and the group's
// shelf reveals by. The repo identity when the project has one, so
// every checkout of a repo is one group. A
// peer's project with no identity can only group with itself, so its
// device names it (peerProjectKey). A local project that claims no
// peers (no identity, or missing on disk) is its own group, by id.
// `deviceId` is the peer holding the project, undefined for this
// machine's.
export function projectGroupKey(
  project: Project,
  deviceId: string | undefined,
): string {
  if (deviceId === undefined)
    return claimsPeers(project) ? project.identity : project.id;
  return project.identity ?? peerProjectKey(deviceId, project.id);
}

// The peers' checkouts split between the groups: each local project's
// claim (aligned with `projects`), then the rest by group key. Remote
// items are grouped up front by repo identity (an identity-less
// project can only group with itself), and the local pass claims
// groups by `get` + `delete`, so whatever remains IS the leftover set
// and a group can never be claimed twice. A peer holding the repo with
// no worktrees to show still joins its group: it is a device the
// header's actions can create on, and a local project with nothing
// under it keeps its header too.
function claimRemote(
  projects: readonly Project[],
  remote: readonly RemoteForestItem[],
): {
  claimed: RemoteForestItem[][];
  peerOnly: Map<string, RemoteForestItem[]>;
} {
  const peerOnly = new Map<string, RemoteForestItem[]>();
  for (const item of remote) {
    const groupKey = projectGroupKey(item.project, item.deviceId);
    const group = peerOnly.get(groupKey);
    if (group) group.push(item);
    else peerOnly.set(groupKey, [item]);
  }
  const claimed = projects.map((project) => {
    if (!claimsPeers(project)) return [];
    const items = peerOnly.get(project.identity) ?? [];
    peerOnly.delete(project.identity);
    return items;
  });
  return { claimed, peerOnly };
}

// Group rank by group id. A repo this machine holds is also ranked
// under the peer-only id it would have, so narrowed to a peer that
// holds it too, the peer's group keeps the local project's place. And
// owner rank by owner key (ownerOf), for the list split by owner.
export interface ProjectGroupOrder {
  groups: ReadonlyMap<string, number>;
  owners: ReadonlyMap<string, number>;
}

// Where each group sits in the tree, decided over every device's
// projects before the device filter narrows them, so picking a device
// only drops groups and never reshuffles the rest. A repo held on
// several devices sorts as one project: its newest use on any of them,
// and its uses on all of them summed. The manual sort has only this
// machine's arranged order to go by, so the repos only peers hold
// trail it in the order they were merged. An owner sits where its
// best-ranked project does, so a usage sort puts the owner of the
// project worked on most first, except under the alphabetical sort,
// where the owners go by name.
export function projectGroupOrder({
  projects,
  remote,
  sortMode,
}: {
  // This machine's projects as buildSidebarRows is handed them, so a
  // repo registered twice here has its peers claimed by the same
  // project in both passes.
  projects: readonly Project[];
  remote: readonly RemoteForestItem[];
  sortMode: ProjectSortMode;
}): ProjectGroupOrder {
  const { claimed, peerOnly } = claimRemote(projects, remote);
  const entries = projects.map((project, i) => ({
    groupIds: claimsPeers(project)
      ? [project.id, remoteGroupId(project.identity)]
      : [project.id],
    project: withMergedUsage(project, claimed[i] ?? []),
  }));
  for (const [groupKey, [first, ...rest]] of peerOnly) {
    if (!first) continue;
    entries.push({
      groupIds: [remoteGroupId(groupKey)],
      project: withMergedUsage(first.project, rest),
    });
  }
  const groups = new Map<string, number>();
  // Owner labels by key, in the order their projects lead them in.
  const owners = new Map<string, string>();
  sortByProject(entries, sortMode, (entry) => entry.project).forEach(
    (entry, rank) => {
      // A repo registered twice here keeps its first project's place.
      for (const id of entry.groupIds)
        if (!groups.has(id)) groups.set(id, rank);
      const owner = ownerOf(entry.project);
      if (owner && !owners.has(owner.key)) owners.set(owner.key, owner.label);
    },
  );
  const ranked =
    sortMode === "alphabetical"
      ? [...owners].toSorted(([, a], [, b]) => a.localeCompare(b))
      : [...owners];
  return {
    groups,
    owners: new Map(ranked.map(([key], rank) => [key, rank])),
  };
}

// One project's usage with every other checkout of it folded in: the
// newest use anywhere, and the uses everywhere summed.
function withMergedUsage(
  project: Project,
  others: readonly RemoteForestItem[],
): Project {
  return {
    ...project,
    lastUsed: Math.max(
      project.lastUsed ?? 0,
      ...others.map((item) => item.project.lastUsed ?? 0),
    ),
    recentCount: others.reduce(
      (sum, item) => sum + (item.project.recentCount ?? 0),
      project.recentCount ?? 0,
    ),
  };
}

// A peer-only group's id: its key (projectGroupKey) behind a prefix,
// so it can never collide with a local project's id and the shell can
// read the key back off a toggle.
const REMOTE_GROUP_PREFIX = "rp:";
const remoteGroupId = (groupKey: string) => `${REMOTE_GROUP_PREFIX}${groupKey}`;
export const remoteGroupKeyOf = (groupId: string): string | undefined =>
  groupId.startsWith(REMOTE_GROUP_PREFIX)
    ? groupId.slice(REMOTE_GROUP_PREFIX.length)
    : undefined;

// Device-qualified: the same repo pulled to two machines can carry
// the same worktree id on both. Shared with the inbox builder so a
// peer's row has one key in both views.
export const remoteWorktreeKey = (deviceId: string, worktreeId: string) =>
  `rw:${deviceId}:${worktreeId}`;

// A worktree's row key wherever it lives: this machine's (deviceId
// undefined) or a peer's. One spelling for the tree, the inbox and the
// ⌘K palette, so a worktree has one identity in all three.
export const worktreeRowKey = (
  deviceId: string | undefined,
  worktreeId: string,
) =>
  deviceId === undefined
    ? `w:${worktreeId}`
    : remoteWorktreeKey(deviceId, worktreeId);

// A peer's badge, as the rows and menus draw it.
export function deviceBadgeOf(item: RemoteForestItem): SidebarDeviceBadge {
  return {
    deviceId: item.deviceId,
    label: item.deviceLabel,
    icon: item.deviceIcon,
    tone: item.tone,
    reachable: item.reachable,
  };
}

type LocalRow = Extract<SidebarRow, { kind: "worktree" }>;
type RemoteRow = Extract<SidebarRow, { kind: "remote-worktree" }>;

function remoteWorktreeRows(
  item: RemoteForestItem,
  groupId: string,
  hiddenPrefixes: readonly string[],
  folded: (peerKey: string, shelf: GroupShelf | null) => boolean,
): RemoteRow[] {
  const rows: RemoteRow[] = [];
  for (const worktree of item.worktrees) {
    const key = remoteWorktreeKey(item.deviceId, worktree.id);
    const shelf = groupShelfOf(worktree, hiddenPrefixes);
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
