import { pullRequestStackPosition, trunkOf } from "@shared/pullRequestStack";
import { MACHINE_FALLBACK_ICON } from "@shared/account/deviceIcon";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { MirrorLink } from "@/hooks/remote/useMirrors";
import type { ProjectWorktreeQueries } from "@/hooks/worktrees/useWorktrees";
import type { Project, ProjectSortMode, Worktree } from "@shared/schemas";
import type { SidebarDeviceBadge } from "./DeviceBadge";
import type {
  RemoteProjectMember,
  SidebarRow,
  SidebarViewModel,
} from "./sidebarRow";
import { sortByProject } from "@/lib/sortProjects";

interface BuildSidebarRowsArgs {
  projects: Project[];
  // Positionally aligned with `projects`.
  worktreeQueries: ProjectWorktreeQueries;
  // Folded group ids: local project ids and peer-only group ids alike.
  collapsed: Set<string>;
  // Re-applied over the groups, so a peer-only project sorts among the
  // local ones (`projects` arrives already in this order).
  sortMode: ProjectSortMode;
  shelvedExpanded: Set<string>;
  arrangeMode: boolean;
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
// peer row (device, worktree) folds into, and the peer device of each
// local worktree in a pair.
export function mirrorPairsOf(mirrors: readonly MirrorLink[]): {
  peerRowsFolded: Map<string, string>;
  peerOfLocal: Map<string, string>;
} {
  const peerRowsFolded = new Map<string, string>();
  const peerOfLocal = new Map<string, string>();
  for (const link of mirrors) {
    peerRowsFolded.set(
      remoteWorktreeKey(link.peerDeviceId, link.peerWorktreeId),
      link.localWorktreeId,
    );
    peerOfLocal.set(link.localWorktreeId, link.peerDeviceId);
  }
  return { peerRowsFolded, peerOfLocal };
}

// The badge a local row wears for the peer it is mirrored with: the
// peer's own when the registry knows it (its label and tone), else
// unnamed. Shared by both builders so a pair reads the same in each.
export function mirrorBadgeLookup(
  peerOfLocal: ReadonlyMap<string, string>,
  deviceBadges: ReadonlyMap<string, SidebarDeviceBadge>,
): (worktree: Worktree) => SidebarDeviceBadge | undefined {
  return (worktree) => {
    const peer = peerOfLocal.get(worktree.id);
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
  collapsed,
  sortMode,
  shelvedExpanded,
  arrangeMode,
  remote,
  mirrors,
  deviceBadges,
}: BuildSidebarRowsArgs): SidebarViewModel {
  const { peerRowsFolded, peerOfLocal } = mirrorPairsOf(mirrors);
  const mirrorBadgeFor = mirrorBadgeLookup(peerOfLocal, deviceBadges);
  // The local rows this build lists, decided up front: a peer's row
  // folds only into a local row that is really on screen. Its listing
  // still loading or failed, or its shelf folded, the peer's row stays
  // its own, or a healthy worktree would vanish behind a local gap. The
  // one exception is a peer's shelved row in the same group: it only
  // shows with that group's shelf open, where every listed local row
  // shows too, so it folds into any of them and the shelf's count holds
  // still across the toggle.
  const listedLocal = new Map<string, { groupId: string; shown: boolean }>();
  projects.forEach((project, i) => {
    if (collapsed.has(project.id) || project.pathExists === false) return;
    const query = worktreeQueries[i];
    // A failed refetch keeps its last data, but the group draws the
    // error row instead of it.
    if (!query || query.error) return;
    const shelfOpen = shelvedExpanded.has(project.id);
    for (const worktree of (query.data ?? []) as Worktree[]) {
      listedLocal.set(worktree.id, {
        groupId: project.id,
        shown: !worktree.shelved || shelfOpen,
      });
    }
  });
  const foldedInto = (
    peerKey: string,
    shelved: boolean,
    groupId: string,
  ): boolean => {
    const local = peerRowsFolded.get(peerKey);
    const listed = local === undefined ? undefined : listedLocal.get(local);
    if (!listed) return false;
    return listed.shown || (shelved && listed.groupId === groupId);
  };
  const localRows = (trees: Worktree[]): SidebarRow[] =>
    trees.map((worktree) => ({
      kind: "worktree",
      key: `w:${worktree.id}`,
      worktree,
      mirror: mirrorBadgeFor(worktree),
    }));

  if (arrangeMode) {
    const rows: SidebarRow[] = projects.map((project) => ({
      kind: "project",
      key: `p:${project.id}`,
      groupId: project.id,
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

  // Remote items grouped up front by repo identity (an identity-less
  // project can only group with itself). The local pass claims groups
  // by `get` + `delete`, so whatever remains IS the leftover set -- one
  // structure, no consumed-tracking, and a group can never be claimed
  // twice. A peer holding the repo with no worktrees to show still joins
  // its group: it is a device the header's actions can create on, and a
  // local project with nothing under it keeps its header too.
  const remoteByIdentity = new Map<string, RemoteForestItem[]>();
  for (const item of remote) {
    const groupKey =
      item.project.identity ?? `${item.deviceId}/${item.project.id}`;
    const group = remoteByIdentity.get(groupKey);
    if (group) group.push(item);
    else remoteByIdentity.set(groupKey, [item]);
  }

  // One group per header: every local project with the peers' checkouts
  // of the same repo, then the repos only peers hold. A project is a
  // project wherever it is checked out, so both kinds sort together and
  // render through the same rows.
  const groups: ProjectGroup[] = projects.map((project, i) => {
    // Claimed by identity even while collapsed or still loading, so a
    // folded project's remote worktrees fold with it instead of
    // reappearing as a duplicate peer-only group. A missing local
    // project claims nothing: its remote counterpart is alive and
    // belongs under its own header.
    let remoteHere: RemoteForestItem[] = [];
    if (project.pathExists !== false && project.identity != null) {
      remoteHere = remoteByIdentity.get(project.identity) ?? [];
      if (remoteHere.length > 0) remoteByIdentity.delete(project.identity);
    }
    return {
      groupId: project.id,
      project,
      query: worktreeQueries[i],
      local: true,
      remote: remoteHere,
    };
  });
  // Whatever the local pass left unclaimed. The same repo on several
  // devices reads as one project (the per-row device marker tells them
  // apart), led by the first device's checkout. They have no stored
  // order, so under the manual sort they trail the list, the way a
  // terrier project does.
  for (const [groupKey, items] of remoteByIdentity) {
    const [first] = items;
    if (!first) continue;
    groups.push({
      groupId: remoteGroupId(groupKey),
      project: first.project,
      query: undefined,
      local: false,
      remote: items,
    });
  }

  const rows: SidebarRow[] = [];
  // The header a folded group's peer rows stand behind, for revealKey.
  const foldedPeerRows = new Map<string, string>();
  for (const group of sortByProject(groups, sortMode, (g) => g.project)) {
    const { groupId, project, query } = group;
    const expanded = !collapsed.has(groupId);
    const headerKey = `p:${groupId}`;
    rows.push({
      kind: "project",
      key: headerKey,
      groupId,
      project,
      local: group.local,
      expanded,
      devices: deviceBadgesOf(group.remote),
      members: membersOf(group.remote),
    });
    if (project.pathExists === false) continue;
    if (!expanded) {
      for (const item of group.remote) {
        for (const worktree of item.worktrees) {
          foldedPeerRows.set(
            remoteWorktreeKey(item.deviceId, worktree.id),
            headerKey,
          );
        }
      }
      continue;
    }
    // Peers' worktrees of this same repo render after the local rows so
    // the local work stays where the eye expects it -- and on EVERY
    // path below: a claimed group that then skipped rendering (local
    // listing still loading, or errored) would vanish from the tree
    // entirely, hiding the peer's perfectly healthy worktrees behind a
    // local-only failure. Their shelved ones share the group's shelf
    // with the local ones, so a device showing only peers' work (the
    // web client) can still reach them.
    const remoteVisible: SidebarRow[] = [];
    const remoteShelved: SidebarRow[] = [];
    for (const item of group.remote) {
      for (const row of remoteWorktreeRows(item, groupId, foldedInto)) {
        (row.worktree.shelved ? remoteShelved : remoteVisible).push(row);
      }
    }
    const localShelved: Worktree[] = [];
    if (query?.isLoading) {
      rows.push({
        kind: "worktree-skeleton",
        key: `sk:${project.id}`,
        projectId: project.id,
      });
    } else if (query?.error) {
      rows.push({
        kind: "worktree-error",
        key: `err:${project.id}`,
        projectId: project.id,
      });
    } else if (query) {
      const localVisible: Worktree[] = [];
      for (const worktree of (query.data ?? []) as Worktree[]) {
        (worktree.shelved ? localShelved : localVisible).push(worktree);
      }
      rows.push(...localRows(localVisible));
    }
    rows.push(...remoteVisible);
    const shelvedCount = localShelved.length + remoteShelved.length;
    if (shelvedCount > 0) {
      const shelfOpen = shelvedExpanded.has(groupId);
      if (shelfOpen) rows.push(...localRows(localShelved), ...remoteShelved);
      // Always anchored at the bottom of the project's section:
      // "N shelved" reveals, "Hide shelved" collapses.
      rows.push({
        kind: "shelved-toggle",
        key: `shelf:${groupId}`,
        groupId,
        count: shelvedCount,
        expanded: shelfOpen,
      });
    }
  }

  return {
    rows,
    // Every project renders a header, so "no rows" here only ever means
    // "no projects", which the shell already has its own answer for.
    emptyMessage: null,
    revealKey: (projectId, worktreeId, deviceId) => {
      // A peer's row is device-qualified (remoteWorktreeRows). It
      // is absent while its listing is in flight, which reveals
      // nothing, or while its group is folded, where the header stands
      // in for it the way a local worktree's does.
      if (deviceId !== undefined) {
        const key = remoteWorktreeKey(deviceId, worktreeId);
        if (rows.some((r) => r.key === key)) return key;
        // A peer's worktree folded into its local mirror: reveal that.
        const local = peerRowsFolded.get(key);
        if (local !== undefined && rows.some((r) => r.key === `w:${local}`)) {
          return `w:${local}`;
        }
        return foldedPeerRows.get(key) ?? null;
      }
      return rows.some((r) => r.key === `w:${worktreeId}`)
        ? `w:${worktreeId}`
        : // Only a folded project stands in for its worktree. A missing
          // row in an open project means the listing hasn't landed yet,
          // and settling for the header there would mark the reveal done
          // and never scroll to the row once it appears.
          collapsed.has(projectId)
          ? headerKeyIfPresent(rows, projectId)
          : null;
    },
  };
}

// A collapsed project hides its worktree rows, so its header is the
// closest thing there is to reveal.
function headerKeyIfPresent(rows: SidebarRow[], projectId: string) {
  const key = `p:${projectId}`;
  return rows.some((r) => r.key === key) ? key : null;
}

// What one header leads. `query` is this machine's worktree listing,
// which a peer-only group has none of.
interface ProjectGroup {
  groupId: string;
  project: Project;
  query: ProjectWorktreeQueries[number] | undefined;
  local: boolean;
  remote: RemoteForestItem[];
}

// A peer-only group's id: its key (repo identity, or device and
// project for an identity-less one) behind a prefix, so it can never
// collide with a local project's id and the shell can tell whose fold a
// toggle is. The key alone is what the fold is stored under.
const REMOTE_GROUP_PREFIX = "rp:";
export const remoteGroupId = (groupKey: string) =>
  `${REMOTE_GROUP_PREFIX}${groupKey}`;
export const remoteGroupKeyOf = (groupId: string): string | undefined =>
  groupId.startsWith(REMOTE_GROUP_PREFIX)
    ? groupId.slice(REMOTE_GROUP_PREFIX.length)
    : undefined;

// Device-qualified: the same repo pulled to two machines can carry
// the same worktree id on both. Shared with the inbox builder so a
// peer's row has one key in both views.
export const remoteWorktreeKey = (deviceId: string, worktreeId: string) =>
  `rw:${deviceId}:${worktreeId}`;

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

type RemoteRow = Extract<SidebarRow, { kind: "remote-worktree" }>;

function remoteWorktreeRows(
  item: RemoteForestItem,
  groupId: string,
  foldedInto: (peerKey: string, shelved: boolean, groupId: string) => boolean,
): RemoteRow[] {
  const rows: RemoteRow[] = [];
  for (const worktree of item.worktrees) {
    const key = remoteWorktreeKey(item.deviceId, worktree.id);
    // The local row of a mirrored pair stands for both copies.
    if (foldedInto(key, worktree.shelved, groupId)) continue;
    rows.push({
      kind: "remote-worktree",
      key,
      worktree,
      deviceId: item.deviceId,
      deviceLabel: item.deviceLabel,
      deviceIcon: item.deviceIcon,
      reachable: item.reachable,
      tone: item.tone,
      pr: item.pullRequests[worktree.branch],
      stack: pullRequestStackPosition(
        item.pullRequests,
        worktree.branch,
        trunkOf(item.worktrees),
      ),
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
