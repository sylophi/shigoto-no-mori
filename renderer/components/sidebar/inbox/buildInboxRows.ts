import type { ProjectShigomoriConfigQueries } from "@/hooks/config/useShigomoriConfig";
import type { ProjectPullRequestQueries } from "@/hooks/projects/useProjectPullRequests";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { ProjectWorktreeQueries } from "@/hooks/worktrees/useWorktrees";
import {
  worktreeLastActivityAt,
  type Project,
  type PullRequest,
  type Worktree,
} from "@shared/schemas";
import { deviceBadgeOf, remoteWorktreeKey } from "../buildSidebarRows";
import type { SidebarDeviceBadge } from "../DeviceBadge";
import type { InboxShelf, SidebarRow, SidebarViewModel } from "../sidebarRow";

interface BuildInboxRowsArgs {
  projects: Project[];
  // All three positionally aligned with `projects`.
  worktreeQueries: ProjectWorktreeQueries;
  pullRequestQueries: ProjectPullRequestQueries;
  // Carries each project's showPrimaryInInbox opt-in.
  configQueries: ProjectShigomoriConfigQueries;
  // Peers' forests, filed into the same three boxes as this machine's:
  // the inbox is one list of everything in flight, wherever it lives.
  // Each item already carries the peer's PR map and its primary opt-in,
  // the same two facts the local queries above answer per project.
  remote: RemoteForestItem[];
  // Which shelves are open. Absence means shut, so both shelves start
  // folded on every launch -- the same reasoning as the per-project
  // "Show shelved" reveal in the classic view.
  openShelves: Set<InboxShelf>;
}

interface Entry {
  worktree: Worktree;
  project: Project;
  pr: PullRequest | undefined;
  // Undefined for this machine's own worktree.
  device: SidebarDeviceBadge | undefined;
  activityAt: number;
}

// A worktree lands in exactly one box. Shelving is an explicit user
// decision, so it outranks mergedness: a shelved branch that also merged
// stays where the user filed it. A primary is always live: it can't be
// shelved, and a merged PR on whatever branch it happens to have checked
// out doesn't make the project's root "done".
function bucketFor(
  worktree: Worktree,
  pr: PullRequest | undefined,
): InboxShelf | "live" {
  if (worktree.isPrimary) return "live";
  if (worktree.shelved) return "shelved";
  if (worktree.mergedIntoPrimary || pr?.state === "MERGED") return "merged";
  return "live";
}

// Newest work first, name as the tiebreak so worktrees with no activity
// at all (fresh, never committed, clean) still land in a stable order.
function byRecency(a: Entry, b: Entry): number {
  const diff = b.activityAt - a.activityAt;
  return diff !== 0 ? diff : a.worktree.name.localeCompare(b.worktree.name);
}

// A local row's key, or the tree's device-qualified one for a peer's.
function entryKey(worktreeId: string, deviceId: string | undefined): string {
  return deviceId === undefined
    ? `w:${worktreeId}`
    : remoteWorktreeKey(deviceId, worktreeId);
}

function worktreeRow(entry: Entry): SidebarRow {
  return {
    kind: "inbox-worktree",
    key: entryKey(entry.worktree.id, entry.device?.deviceId),
    worktree: entry.worktree,
    project: entry.project,
    pr: entry.pr,
    device: entry.device,
  };
}

// Flattens every project's worktrees -- this machine's and every peer's
// -- into the inbox view's three boxes: live work at the top with no
// header, then the Shelved and Merged shelves. Primary checkouts are
// left out unless the project opts in
// (ShigomoriConfigSchema.showPrimaryInInbox) -- they're a project's
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
  openShelves,
}: BuildInboxRowsArgs): SidebarViewModel {
  // Remote listing failures count beside the local ones, so the shell's
  // coalesced fan-out toast covers the whole list.
  const failedCount =
    worktreeQueries.filter((q) => q.error).length +
    remote.filter((item) => item.worktreesError).length;
  const loadingCount = worktreeQueries.filter((q) => q.isLoading).length;

  const live: Entry[] = [];
  const shelves: Record<InboxShelf, Entry[]> = { shelved: [], merged: [] };
  // Filed for every shelved worktree, open shelf or not -- it's the
  // folded case that revealKey needs an answer for. Keyed like the rows.
  const shelfOf = new Map<string, InboxShelf>();
  const file = (
    project: Project,
    trees: Worktree[],
    prs: Record<string, PullRequest> | undefined,
    showPrimary: boolean,
    device: SidebarDeviceBadge | undefined,
  ) => {
    for (const worktree of trees) {
      if (worktree.isPrimary && !showPrimary) continue;
      const entry: Entry = {
        worktree,
        project,
        pr: prs?.[worktree.branch],
        device,
        activityAt: worktreeLastActivityAt(worktree),
      };
      const bucket = bucketFor(worktree, entry.pr);
      if (bucket === "live") {
        live.push(entry);
      } else {
        shelves[bucket].push(entry);
        shelfOf.set(entryKey(worktree.id, device?.deviceId), bucket);
      }
    }
  };
  projects.forEach((project, i) => {
    if (project.pathExists === false) return;
    file(
      project,
      (worktreeQueries[i]?.data ?? []) as Worktree[],
      pullRequestQueries[i]?.data,
      configQueries[i]?.data?.showPrimaryInInbox === true,
      undefined,
    );
  });
  for (const item of remote) {
    file(
      item.project,
      item.worktrees,
      item.pullRequests,
      item.showPrimaryInInbox,
      deviceBadgeOf(item),
    );
  }

  const total = live.length + shelves.shelved.length + shelves.merged.length;
  const rows: SidebarRow[] = live.toSorted(byRecency).map(worktreeRow);
  for (const shelf of ["shelved", "merged"] as const) {
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
    rows.push(...entries.toSorted(byRecency).map(worktreeRow));
  }

  return {
    rows,
    failedCount,
    // Only once every listing has landed and none of them failed. An
    // empty list looks the same whether the answer is "nothing here",
    // "still asking", or "couldn't ask" -- and the last two have their
    // own signals already (the skeleton, the fan-out toast), so
    // asserting the first over them is the one wrong answer available.
    // (The shell gates this on the remote listings still being in
    // flight, the same way it gates the tree's.)
    emptyMessage:
      total === 0 && loadingCount === 0 && failedCount === 0
        ? "No worktrees yet."
        : null,
    revealKey: (_projectId, worktreeId, deviceId) => {
      const key = entryKey(worktreeId, deviceId);
      const shelf = shelfOf.get(key);
      if (shelf && !openShelves.has(shelf)) return `shelf:${shelf}`;
      return rows.some((r) => r.key === key) ? key : null;
    },
  };
}
