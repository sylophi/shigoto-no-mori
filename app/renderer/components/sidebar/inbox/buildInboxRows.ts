import { pullRequestStackPosition, trunkOf } from "@shared/pullRequestStack";
import { groupPrefixOf } from "@shared/sharedSettings";
import type { ProjectShigomoriConfigQueries } from "@/hooks/config/useShigomoriConfig";
import { showPrimaryInInbox } from "@/lib/showPrimaryInInbox";
import type { MirrorLink } from "@/hooks/remote/useMirrors";
import type { ProjectPullRequestQueries } from "@/hooks/projects/useProjectPullRequests";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { ProjectWorktreeQueries } from "@/hooks/worktrees/useWorktrees";
import {
  type Project,
  type PullRequest,
  type Worktree,
} from "@shigomori/contracts/schemas";
import {
  deviceBadgeOf,
  groupShelfOf,
  mirrorBadgeLookup,
  mirrorPairsOf,
  remoteWorktreeKey,
  worktreeRowKey,
} from "../buildSidebarRows";
import type { SidebarDeviceBadge } from "../DeviceBadgeView";
import type { StackPosition } from "@shared/pullRequestStack";
import type { InboxShelf, SidebarRow, SidebarViewModel } from "../sidebarRow";
import { byInboxRank, inboxRank, type InboxRank } from "./inboxRank";

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

// A worktree lands in exactly one box. An agent's working mark and
// shelving are explicit decisions (groupShelfOf), so they outrank
// mergedness: a shelved branch that also merged stays where the user
// filed it. The hidden prefixes are one too, just
// made ahead of time. A primary is always live: it can't be
// shelved, and a merged PR on whatever branch it happens to have checked
// out doesn't make the project's root "done".
function bucketFor(
  worktree: Worktree,
  pr: PullRequest | undefined,
  prefixes: readonly string[],
  allowAgentWorking: boolean,
): InboxShelf | "live" {
  if (worktree.isPrimary) return "live";
  const shelf = groupShelfOf(worktree, prefixes, allowAgentWorking);
  if (shelf !== null) return shelf;
  if (worktree.mergedIntoPrimary || pr?.state === "MERGED") return "merged";
  return "live";
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
  const localBucket = new Map<string, InboxShelf | "live">();
  const file = (
    project: Project,
    trees: readonly Worktree[],
    prs: Record<string, PullRequest> | undefined,
    // Undefined while the project's config is unread.
    showPrimary: boolean | undefined,
    device: SidebarDeviceBadge | undefined,
  ) => {
    const trunk = trunkOf(trees);
    for (const worktree of trees) {
      if (worktree.isPrimary && showPrimary !== true) {
        if (showPrimary === false) {
          leftOut.add(worktreeRowKey(device?.deviceId, worktree.id));
        }
        continue;
      }
      const pr = prs?.[worktree.branch];
      const bucket = bucketFor(worktree, pr, hiddenPrefixes, allowAgentWorking);
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
        shelf: bucket === "live" ? null : bucket,
      };
      if (device === undefined) localBucket.set(worktree.id, bucket);
      if (bucket === "live") {
        live.push(entry);
      } else {
        shelves[bucket].push(entry);
        shelfOf.set(worktreeRowKey(device?.deviceId, worktree.id), bucket);
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
  // the list with it. The local row a folded peer's reveal lands on,
  // by the peer's key.
  const foldedPeers = new Map<string, string>();
  for (const item of remote) {
    file(
      item.project,
      item.worktrees.filter((worktree) => {
        const key = remoteWorktreeKey(item.deviceId, worktree.id);
        const local = peerRowsFolded.get(key);
        if (local === undefined) return true;
        const pr = item.pullRequests[worktree.branch];
        if (
          localBucket.get(local) !==
          bucketFor(worktree, pr, hiddenPrefixes, allowAgentWorking)
        ) {
          return true;
        }
        foldedPeers.set(key, local);
        return false;
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
  for (const shelf of [
    "agentWorking",
    "shelved",
    "merged",
    "hidden",
  ] as const) {
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
    leftOut: (worktreeId, deviceId) =>
      leftOut.has(worktreeRowKey(deviceId, worktreeId)),
    revealKey: (_projectId, worktreeId, deviceId) => {
      // A peer's worktree folded into its local mirror: reveal that.
      const peerKey = worktreeRowKey(deviceId, worktreeId);
      const local = foldedPeers.get(peerKey);
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
