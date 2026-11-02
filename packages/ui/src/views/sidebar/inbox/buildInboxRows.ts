import {
  pullRequestStackPosition,
  type StackPosition,
  trunkOf,
} from "@shigomori/contracts/pullRequestStack";
import { groupPrefixOf } from "@shigomori/contracts/sharedSettings";
import {
  deviceFiling,
  type ForestDevice,
  type ForestItem,
  mirrorBadgeOf,
  type MirrorPair,
  mirrorPairsOf,
  worktreeAt,
  worktreeRowKey,
  worktreeShelfOf,
} from "../../../lib/forest.ts";
import type { Project, PullRequest } from "@shigomori/contracts/schemas";
import type { SidebarDeviceBadge } from "../DeviceBadgeView.tsx";
import {
  INBOX_SHELVES,
  type InboxShelf,
  type SidebarRow,
  type SidebarViewModel,
} from "../sidebarRow.ts";
import { byInboxRank, inboxRank, type InboxRank } from "./inboxRank.ts";

interface BuildInboxRowsArgs {
  // Every device's projects, this machine's first, filed into the same
  // boxes: the inbox is one list of everything in flight, wherever it
  // lives.
  items: readonly ForestItem[];
  // The device the filter picked, null for every device: what files is
  // deviceFiling's.
  deviceFilter: string | null;
  // See buildSidebarRows: a mirrored pair files once, as the kept row.
  mirrors: readonly MirrorPair[];
  // Every peer's badge off the device registry (see buildSidebarRows).
  deviceBadges: ReadonlyMap<string, SidebarDeviceBadge>;
  // Which shelves are open. Absence means shut, so both shelves start
  // folded on every launch, the same reasoning as the per-group
  // "Show shelved" reveal in the classic view.
  openShelves: ReadonlySet<string>;
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
  project: Project;
  pr: PullRequest | undefined;
  stack: StackPosition | null;
  // Where it is (worktreeAt), and its row's key.
  at: string;
  key: string;
  device: ForestDevice;
  mirror: SidebarDeviceBadge | undefined;
  mirrorWorktreeId: string | undefined;
  shelf: InboxShelf | null;
}

function worktreeRow(entry: Entry): SidebarRow {
  return {
    kind: "inbox-worktree",
    key: entry.key,
    deviceId: entry.device.deviceId,
    worktree: entry.worktree,
    project: entry.project,
    pr: entry.pr,
    stack: entry.stack,
    device: entry.device.isThisDevice ? undefined : entry.device,
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
  items,
  deviceFilter,
  mirrors,
  deviceBadges,
  openShelves,
  hiddenPrefixes,
  groupedPrefixes,
  shutGroups,
  allowAgentWorking,
  pinWaiting,
}: BuildInboxRowsArgs): SidebarViewModel {
  const { keptOf, foldedOf } = mirrorPairsOf(mirrors);

  const files = deviceFiling(deviceFilter, mirrors);
  // The primaries left out because their project keeps them out, by
  // worktreeAt. Not one whose config is still unread: that one may yet
  // show.
  const leftOut = new Set<string>();
  // Every worktree the filter keeps, in the items' order, before the
  // folds.
  const listed: Entry[] = [];
  for (const item of items) {
    if (item.project.pathExists === false) continue;
    const { device, project, pullRequests: prs } = item;
    const trunk = trunkOf(item.worktrees);
    for (const worktree of item.worktrees) {
      if (!files(device.deviceId, worktree.id)) continue;
      const at = worktreeAt(device.deviceId, worktree.id);
      if (worktree.isPrimary && item.showPrimaryInInbox !== true) {
        if (item.showPrimaryInInbox === false) leftOut.add(at);
        continue;
      }
      const pr = prs[worktree.branch];
      const folded = foldedOf.get(at);
      listed.push({
        ...inboxRank(worktree, pinWaiting),
        project,
        pr,
        stack: pullRequestStackPosition(prs, worktree.branch, trunk),
        at,
        key: worktreeRowKey(device, worktree.id),
        device,
        mirror: mirrorBadgeOf(folded, deviceBadges),
        mirrorWorktreeId: folded?.worktreeId,
        shelf: worktreeShelfOf(worktree, pr, hiddenPrefixes, allowAgentWorking),
      });
    }
  }

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
  // Every entry's row key, by worktreeAt, for revealKey.
  const filed = new Map<string, string>();
  // A folded side's row folds only into a kept entry in the same box: a
  // kept copy on a shelf would take the other's live worktree off the
  // list with it.
  const boxOf = new Map(listed.map((entry) => [entry.at, entry.shelf]));
  for (const entry of listed) {
    const kept = keptOf.get(entry.at);
    if (kept !== undefined && boxOf.get(kept) === entry.shelf) continue;
    filed.set(entry.at, entry.key);
    if (entry.shelf === null) {
      live.push(entry);
    } else {
      shelves[entry.shelf].push(entry);
      shelfOf.set(entry.key, entry.shelf);
    }
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
    groupOf.set(entry.key, prefix);
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
    // Only once every listing the filter shows has landed and none of
    // them failed. An empty list looks the same whether the answer is
    // "nothing here", "still asking", or "couldn't ask". The last two
    // have their own signals already (the skeleton, the fan-out
    // toast), so asserting the first over them is the one wrong answer
    // available.
    // (The shell gates this on the peers' listings still being in
    // flight or failed, the same way it gates the tree's.)
    emptyMessage:
      total === 0 &&
      items.every(
        (item) =>
          item.listing === "ready" ||
          (deviceFilter !== null && item.device.deviceId !== deviceFilter),
      )
        ? "No worktrees yet."
        : null,
    // A page's own entry only: a peer's worktree with none may just be
    // unlisted yet, which a device the filter hides looks the same as.
    leftOut: (worktreeId, deviceId) =>
      leftOut.has(worktreeAt(deviceId, worktreeId)),
    revealKey: (_projectId, worktreeId, deviceId) => {
      // A worktree with no entry of its own (folded into its pair's
      // kept row, its device hidden by the filter, or not listed yet):
      // reveal the kept row, the pair's.
      const at = worktreeAt(deviceId, worktreeId);
      const kept = keptOf.get(at);
      const key = filed.get(at) ?? (kept && filed.get(kept));
      if (key === undefined) return null;
      const shelf = shelfOf.get(key);
      if (shelf && !openShelves.has(shelf)) return `shelf:${shelf}`;
      const group = groupOf.get(key);
      if (group !== undefined && shutGroups.has(group)) return `group:${group}`;
      return rows.some((r) => r.key === key) ? key : null;
    },
  };
}
