import {
  pullRequestStackPosition,
  trunkOf,
} from "@shigomori/contracts/pullRequestStack";
import { groupPrefixOf } from "@shigomori/contracts/sharedSettings";
import type { ProjectShigomoriConfigQueries } from "../../../lib/forest.ts";
import { showPrimaryInInbox } from "../../../lib/showPrimaryInInbox.ts";
import type { LocalSide, MirrorLink } from "../../../lib/forest.ts";
import type { ProjectPullRequestQueries } from "../../../lib/forest.ts";
import type { RemoteForestItem } from "../../../lib/forest.ts";
import type { ProjectWorktreeQueries } from "../../../lib/forest.ts";
import {
  type Project,
  type PullRequest,
  type Worktree,
} from "@shigomori/contracts/schemas";
import {
  deviceBadgeOf,
  mirrorBadgeLookup,
  mirrorPairsOf,
  remoteWorktreeKey,
  worktreeRowKey,
  worktreeShelfOf,
} from "../buildSidebarRows.ts";
import type { SidebarDeviceBadge } from "../DeviceBadgeView.tsx";
import type { StackPosition } from "@shigomori/contracts/pullRequestStack";
import {
  INBOX_SHELVES,
  type InboxShelf,
  type SidebarRow,
  type SidebarViewModel,
} from "../sidebarRow.ts";
import { byInboxRank, inboxRank, type InboxRank } from "./inboxRank.ts";

interface BuildInboxRowsArgs {
  projects: readonly Project[];
  // All three positionally aligned with `projects`.
  worktreeQueries: ProjectWorktreeQueries;
  pullRequestQueries: ProjectPullRequestQueries;
  // Carries each project's showPrimaryInInbox opt-in.
  configQueries: ProjectShigomoriConfigQueries;
  // Peers' forests, filed into the same boxes as this machine's:
  // the inbox is one list of everything in flight, wherever it lives.
  // Each item already carries the peer's PR map and its primary opt-in,
  // the same two facts the local queries above answer per project.
  remote: RemoteForestItem[];
  // See buildSidebarRows: a mirrored pair files once, as the local row.
  mirrors: readonly MirrorLink[];
  // See buildSidebarRows: this device's sides of pairs whose projects
  // `projects` leaves out, filed as this machine's own.
  localSides?: ReadonlyMap<string, LocalSide>;
  // Every peer's badge off the device registry (see buildSidebarRows).
  deviceBadges: ReadonlyMap<string, SidebarDeviceBadge>;
  // Which shelves are open. Absence means shut, so both shelves start
  // folded on every launch, the same reasoning as the per-group
  // "Show shelved" reveal in the classic view.
  openShelves: Set<InboxShelf>;
  // Worktrees starting with one of these go on the Hidden shelf.
  hiddenPrefixes: readonly string[];
  // The live worktrees starting with one of these gather under a
  // header per prefix (groupPrefixOf), the ones in `shutGroups` drawn
  // as their header alone.
  groupedPrefixes: readonly string[];
  shutGroups: ReadonlySet<string>;
  // Whether a working agent session shelves its worktree (isAgentWorking).
  allowAgentWorking: boolean;
  // Whether a worktree whose agent waits on you leads its box (inboxRank).
  pinWaiting: boolean;
}

interface Entry extends InboxRank {
  worktree: Worktree;
  project: Project;
  pr: PullRequest | undefined;
  stack: StackPosition | null;
  // Undefined for this machine's own worktree.
  device: SidebarDeviceBadge | undefined;
  mirror: SidebarDeviceBadge | undefined;
  mirrorWorktreeId: string | undefined;
  shelf: InboxShelf | null;
}

function worktreeRow(entry: Entry): SidebarRow {
  return {
    kind: "inbox-worktree",
    key: worktreeRowKey(entry.device?.deviceId, entry.worktree.id),
    worktree: entry.worktree,
    project: entry.project,
    pr: entry.pr,
    stack: entry.stack,
    device: entry.device,
    mirror: entry.mirror,
    mirrorWorktreeId: entry.mirrorWorktreeId,
    shelf: entry.shelf,
  };
}

// Flattens every project's worktrees (this machine's and every peer's)
// into the inbox view's boxes: live work at the top with no header,
// the live work a grouped prefix gathers under its header, then the
// Agent working, Shelved, Merged and Hidden shelves. Primary
// checkouts are left out unless the project opts in
// (ShigomoriConfigSchema.showPrimaryInInbox). They're a project's
// root, not a piece of in-flight work, and one per project would crowd
// out everything the list exists to show.
//
// A plain function for the same reason as buildSidebarRows: the queries
// belong to the Sidebar, so switching views is free.
export function buildInboxRows({
  projects,
  worktreeQueries,
  pullRequestQueries,
  configQueries,
  remote,
  mirrors,
  localSides = new Map(),
  deviceBadges,
  openShelves,
  hiddenPrefixes,
  groupedPrefixes,
  shutGroups,
  allowAgentWorking,
  pinWaiting,
}: BuildInboxRowsArgs): SidebarViewModel {
  const { peerRowsFolded, peerOfLocal } = mirrorPairsOf(mirrors);
  // Failed listings, local or remote, hold the empty message back (the
  // shell's fan-out toast counts them on its own).
  const failedCount =
    worktreeQueries.filter((q) => q.error).length +
    remote.filter((item) => item.worktreesError).length;
  const loadingCount = worktreeQueries.filter((q) => q.isLoading).length;
  const mirrorBadgeFor = mirrorBadgeLookup(peerOfLocal, deviceBadges);

  const live: Entry[] = [];
  const shelves: Record<InboxShelf, Entry[]> = {
    agentWorking: [],
    shelved: [],
    merged: [],
    hidden: [],
  };
  // Filed for every shelved worktree, open shelf or not. It's the
  // folded case that revealKey needs an answer for. Keyed like the rows.
  const shelfOf = new Map<string, InboxShelf>();
  // The primaries left out because their project keeps them out, by row
  // key. Not one whose config is still unread: that one may yet show.
  const leftOut = new Set<string>();
  // Where each of this machine's entries filed, for the peers' rows to
  // fold into.
  const localShelf = new Map<string, InboxShelf | null>();
  // Every entry filed, by row key, for revealKey.
  const filed = new Set<string>();
  const file = (
    project: Project,
    trees: readonly Worktree[],
    prs: Record<string, PullRequest> | undefined,
    // Undefined while the project's config is unread.
    showPrimary: boolean | undefined,
    device: SidebarDeviceBadge | undefined,
    // The stack's trunk, off the project's listing.
    trunk = trunkOf(trees),
  ) => {
    for (const worktree of trees) {
      if (worktree.isPrimary && showPrimary !== true) {
        if (showPrimary === false) {
          leftOut.add(worktreeRowKey(device?.deviceId, worktree.id));
        }
        continue;
      }
      const pr = prs?.[worktree.branch];
      const shelf = worktreeShelfOf(
        worktree,
        pr,
        hiddenPrefixes,
        allowAgentWorking,
      );
      const entry: Entry = {
        ...inboxRank(worktree, pinWaiting),
        project,
        pr,
        stack: pullRequestStackPosition(prs, worktree.branch, trunk),
        device,
        mirror: device === undefined ? mirrorBadgeFor(worktree) : undefined,
        mirrorWorktreeId:
          device === undefined
            ? peerOfLocal.get(worktree.id)?.peerWorktreeId
            : undefined,
        shelf,
      };
      if (device === undefined) localShelf.set(worktree.id, shelf);
      filed.add(worktreeRowKey(device?.deviceId, worktree.id));
      if (shelf === null) {
        live.push(entry);
      } else {
        shelves[shelf].push(entry);
        shelfOf.set(worktreeRowKey(device?.deviceId, worktree.id), shelf);
      }
    }
  };
  projects.forEach((project, i) => {
    if (project.pathExists === false) return;
    file(
      project,
      (worktreeQueries[i]?.data ?? []) as readonly Worktree[],
      pullRequestQueries[i]?.data,
      showPrimaryInInbox(configQueries[i]?.data),
      undefined,
    );
  });
  // A peer's row folds only into a local entry filed in the same box:
  // a local copy on a shelf would take the peer's live worktree off
  // the list with it. Where `projects` leaves this machine's project
  // out, its side of a pair with the peer (localSides) files first, as
  // this machine's own: its own primary opt-in, and the repo's pull
  // requests and trunk off the peer's listing.
  for (const item of remote) {
    const localOf = (worktree: Worktree) =>
      peerRowsFolded.get(remoteWorktreeKey(item.deviceId, worktree.id));
    for (const worktree of item.worktrees) {
      const local = localOf(worktree);
      const side = local === undefined ? undefined : localSides.get(local);
      if (side === undefined) continue;
      file(
        side.project,
        [side.worktree],
        item.pullRequests,
        side.showPrimaryInInbox,
        undefined,
        trunkOf(item.worktrees),
      );
    }
    file(
      item.project,
      item.worktrees.filter((worktree) => {
        const local = localOf(worktree);
        if (local === undefined) return true;
        const pr = item.pullRequests[worktree.branch];
        return (
          localShelf.get(local) !==
          worktreeShelfOf(worktree, pr, hiddenPrefixes, allowAgentWorking)
        );
      }),
      item.pullRequests,
      item.showPrimaryInInbox,
      deviceBadges.get(item.deviceId) ?? deviceBadgeOf(item),
    );
  }

  const total = Object.values(shelves).reduce(
    (sum, entries) => sum + entries.length,
    live.length,
  );
  // The prefixes' headers in their (sorted) order, after the rest. A
  // stack's layers file one by one: the inbox orders by recency, so
  // there is no rail to keep in one piece.
  const rest: Entry[] = [];
  const grouped = new Map<string, Entry[]>();
  // Each grouped worktree's prefix, open group or not, like shelfOf.
  const groupOf = new Map<string, string>();
  for (const entry of live) {
    const prefix = groupPrefixOf(entry.worktree, groupedPrefixes);
    if (prefix === null) {
      rest.push(entry);
      continue;
    }
    const entries = grouped.get(prefix) ?? [];
    grouped.set(prefix, entries);
    entries.push(entry);
    groupOf.set(
      worktreeRowKey(entry.device?.deviceId, entry.worktree.id),
      prefix,
    );
  }
  const rows: SidebarRow[] = rest.toSorted(byInboxRank).map(worktreeRow);
  for (const prefix of groupedPrefixes) {
    const entries = grouped.get(prefix);
    if (!entries) continue;
    const expanded = !shutGroups.has(prefix);
    rows.push({
      kind: "inbox-group",
      key: `group:${prefix}`,
      prefix,
      count: entries.length,
      expanded,
    });
    if (!expanded) continue;
    rows.push(...entries.toSorted(byInboxRank).map(worktreeRow));
  }
  for (const shelf of INBOX_SHELVES) {
    const entries = shelves[shelf];
    if (entries.length === 0) continue;
    const expanded = openShelves.has(shelf);
    rows.push({
      kind: "inbox-shelf",
      key: `shelf:${shelf}`,
      shelf,
      count: entries.length,
      expanded,
    });
    if (!expanded) continue;
    rows.push(...entries.toSorted(byInboxRank).map(worktreeRow));
  }

  return {
    rows,
    // Only once every listing has landed and none of them failed. An
    // empty list looks the same whether the answer is "nothing here",
    // "still asking", or "couldn't ask". The last two have their own
    // signals already (the skeleton, the fan-out toast), so asserting
    // the first over them is the one wrong answer available.
    // (The shell gates this on the remote listings still being in
    // flight, the same way it gates the tree's.)
    emptyMessage:
      total === 0 && loadingCount === 0 && failedCount === 0
        ? "No worktrees yet."
        : null,
    // A page's own entry only: a peer's worktree with none may just be
    // unlisted yet, which a device the filter hides looks the same as.
    leftOut: (worktreeId, deviceId) =>
      leftOut.has(worktreeRowKey(deviceId, worktreeId)),
    revealKey: (_projectId, worktreeId, deviceId) => {
      // A peer's worktree with no entry of its own (folded into its
      // local mirror, its device hidden by the filter, or not listed
      // yet): reveal its local mirror, the pair's row.
      const peerKey = worktreeRowKey(deviceId, worktreeId);
      const local = filed.has(peerKey)
        ? undefined
        : peerRowsFolded.get(peerKey);
      const key =
        local === undefined ? peerKey : worktreeRowKey(undefined, local);
      const shelf = shelfOf.get(key);
      if (shelf && !openShelves.has(shelf)) return `shelf:${shelf}`;
      const group = groupOf.get(key);
      if (group !== undefined && shutGroups.has(group)) return `group:${group}`;
      return rows.some((r) => r.key === key) ? key : null;
    },
  };
}
