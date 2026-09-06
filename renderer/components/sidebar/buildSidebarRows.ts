import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { ProjectWorktreeQueries } from "@/hooks/worktrees/useWorktrees";
import type { Project, Worktree } from "@shared/schemas";
import type { SidebarDeviceBadge } from "./DeviceBadge";
import type { SidebarRow, SidebarViewModel } from "./sidebarRow";

interface BuildSidebarRowsArgs {
  projects: Project[];
  // Positionally aligned with `projects`.
  worktreeQueries: ProjectWorktreeQueries;
  collapsed: Set<string>;
  shelvedExpanded: Set<string>;
  arrangeMode: boolean;
  // Peer devices' forests, merged into the tree: a remote project
  // sharing a local project's repo identity contributes its worktrees
  // to that group (marked per row), the rest gather under
  // remote-project headers after the local projects.
  remote: RemoteForestItem[];
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
  shelvedExpanded,
  arrangeMode,
  remote,
}: BuildSidebarRowsArgs): SidebarViewModel {
  // Remote listing failures count beside the local ones, so the shell's
  // coalesced fan-out toast covers the whole tree.
  const failedCount =
    worktreeQueries.filter((q) => q.error).length +
    remote.filter((item) => item.worktreesError).length;

  if (arrangeMode) {
    const rows: SidebarRow[] = projects.map((project) => ({
      kind: "project",
      key: `p:${project.id}`,
      project,
      expanded: false,
      devices: [],
      members: [],
    }));
    return {
      rows,
      failedCount,
      emptyMessage: null,
      revealKey: (projectId) => headerKeyIfPresent(rows, projectId),
    };
  }

  // Remote items grouped up front by repo identity (an identity-less
  // project can only group with itself). The local pass claims groups
  // by `get` + `delete`, so whatever remains IS the leftover set -- one
  // structure, no consumed-tracking, and a group can never be claimed
  // twice. Shelving is a local noise-control preference, so a peer's
  // shelved worktrees stay in its own sidebar, not this one's. A peer
  // holding the repo with no worktrees to show still joins its group:
  // it is a device the header's actions can create on, and a local
  // project with nothing under it keeps its header too.
  const remoteByIdentity = new Map<string, RemoteForestItem[]>();
  for (const raw of remote) {
    const worktrees = raw.worktrees.filter((worktree) => !worktree.shelved);
    const item = { ...raw, worktrees };
    const groupKey =
      item.project.identity ?? `${item.deviceId}/${item.project.id}`;
    const group = remoteByIdentity.get(groupKey);
    if (group) group.push(item);
    else remoteByIdentity.set(groupKey, [item]);
  }

  const rows: SidebarRow[] = [];
  projects.forEach((project, i) => {
    const expanded = !collapsed.has(project.id);
    // Claimed by identity even while collapsed or still loading, so a
    // folded project's remote worktrees fold with it instead of
    // reappearing below as a duplicate remote-project group. A missing
    // local project claims nothing: its remote counterpart is alive and
    // belongs under its own header.
    let remoteHere: RemoteForestItem[] = [];
    if (project.pathExists !== false && project.identity != null) {
      remoteHere = remoteByIdentity.get(project.identity) ?? [];
      if (remoteHere.length > 0) remoteByIdentity.delete(project.identity);
    }
    rows.push({
      kind: "project",
      key: `p:${project.id}`,
      project,
      expanded,
      devices: deviceBadgesOf(remoteHere),
      members: membersOf(remoteHere),
    });
    if (!expanded || project.pathExists === false) return;
    // Peers' worktrees of this same repo render after the local rows so
    // the local work stays where the eye expects it -- and on EVERY
    // path below: a claimed group that then skipped rendering (local
    // listing still loading, or errored) would vanish from the tree
    // entirely, hiding the peer's perfectly healthy worktrees behind a
    // local-only failure.
    const pushRemoteHere = () => {
      for (const item of remoteHere) {
        pushRemoteWorktreeRows(rows, item, project.id);
      }
    };
    const query = worktreeQueries[i];
    if (!query) {
      pushRemoteHere();
      return;
    }
    if (query.isLoading) {
      rows.push({
        kind: "worktree-skeleton",
        key: `sk:${project.id}`,
        projectId: project.id,
      });
      pushRemoteHere();
      return;
    }
    if (query.error) {
      rows.push({
        kind: "worktree-error",
        key: `err:${project.id}`,
        projectId: project.id,
      });
      pushRemoteHere();
      return;
    }
    const trees = (query.data ?? []) as Worktree[];
    const visible = trees.filter((w) => !w.shelved);
    const shelved = trees.filter((w) => w.shelved);
    for (const worktree of visible) {
      rows.push({
        kind: "worktree",
        key: `w:${worktree.id}`,
        worktree,
      });
    }
    pushRemoteHere();
    if (shelved.length > 0) {
      const shelfOpen = shelvedExpanded.has(project.id);
      if (shelfOpen) {
        for (const worktree of shelved) {
          rows.push({
            kind: "worktree",
            key: `w:${worktree.id}`,
            worktree,
          });
        }
      }
      // Always anchored at the bottom of the project's section:
      // "N shelved" reveals, "Hide shelved" collapses.
      rows.push({
        kind: "shelved-toggle",
        key: `shelf:${project.id}`,
        projectId: project.id,
        count: shelved.length,
        expanded: shelfOpen,
      });
    }
  });

  // Whatever the local pass left unclaimed: remote projects with no
  // local counterpart, after the local tree. The same repo on several
  // devices reads as one project (the per-row device marker tells them
  // apart), and the header's icon and actions come off its live members.
  for (const [groupKey, items] of remoteByIdentity) {
    const [first] = items;
    if (!first) continue;
    const groupId = `rp:${groupKey}`;
    rows.push({
      kind: "remote-project",
      key: groupId,
      name: first.project.name,
      count: items.reduce((sum, item) => sum + item.worktrees.length, 0),
      devices: deviceBadgesOf(items),
      members: membersOf(items),
    });
    for (const item of items) {
      pushRemoteWorktreeRows(rows, item, groupId);
    }
  }

  return {
    rows,
    failedCount,
    // Every project renders a header, so "no rows" here only ever means
    // "no projects" -- which the shell already has its own answer for.
    emptyMessage: null,
    revealKey: (projectId, worktreeId, deviceId) => {
      // A peer's row is device-qualified (pushRemoteWorktreeRows). It
      // is absent while its listing is in flight or while the local
      // group it merged into is folded, and neither reveals anything.
      if (deviceId !== undefined) {
        const key = remoteWorktreeKey(deviceId, worktreeId);
        return rows.some((r) => r.key === key) ? key : null;
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
    tone: item.tone,
    reachable: item.reachable,
  };
}

function pushRemoteWorktreeRows(
  rows: SidebarRow[],
  item: RemoteForestItem,
  groupId: string,
): void {
  for (const worktree of item.worktrees) {
    rows.push({
      kind: "remote-worktree",
      key: remoteWorktreeKey(item.deviceId, worktree.id),
      worktree,
      deviceId: item.deviceId,
      deviceLabel: item.deviceLabel,
      reachable: item.reachable,
      tone: item.tone,
      pr: item.pullRequests[worktree.branch],
      groupId,
    });
  }
}

// The group's (device, project) pairs, in the order they were merged,
// one per device like the badges: a device that registered the same
// repo twice acts through its first registration.
function membersOf(
  items: readonly RemoteForestItem[],
): { deviceId: string; deviceLabel: string; project: Project }[] {
  const members = new Map<
    string,
    { deviceId: string; deviceLabel: string; project: Project }
  >();
  for (const item of items) {
    if (!members.has(item.deviceId)) {
      members.set(item.deviceId, {
        deviceId: item.deviceId,
        deviceLabel: item.deviceLabel,
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
