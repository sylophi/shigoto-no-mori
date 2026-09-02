import type { ProjectPullRequestQueries } from "@/hooks/projects/useProjectPullRequests";
import type { ProjectWorktreeQueries } from "@/hooks/worktrees/useWorktrees";
import {
  worktreeLastActivityAt,
  type Project,
  type PullRequest,
  type Worktree,
} from "@shared/schemas";
import type { InboxShelf, SidebarRow, SidebarViewModel } from "../sidebarRow";

interface BuildInboxRowsArgs {
  projects: Project[];
  // Both positionally aligned with `projects`.
  worktreeQueries: ProjectWorktreeQueries;
  pullRequestQueries: ProjectPullRequestQueries;
  // Which shelves are open. Absence means shut, so both shelves start
  // folded on every launch -- the same reasoning as the per-project
  // "Show shelved" reveal in the classic view.
  openShelves: Set<InboxShelf>;
}

interface Entry {
  worktree: Worktree;
  project: Project;
  pr: PullRequest | undefined;
  activityAt: number;
}

// A worktree lands in exactly one box. Shelving is an explicit user
// decision, so it outranks mergedness: a shelved branch that also merged
// stays where the user filed it.
function bucketFor(
  worktree: Worktree,
  pr: PullRequest | undefined,
): InboxShelf | "live" {
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

function worktreeRow(entry: Entry): SidebarRow {
  return {
    kind: "inbox-worktree",
    key: `w:${entry.worktree.id}`,
    worktree: entry.worktree,
    project: entry.project,
    pr: entry.pr,
  };
}

// Flattens every project's worktrees into the inbox view's three boxes:
// live work at the top with no header, then the Shelved and Merged
// shelves. Primary checkouts are left out entirely -- they're a
// project's root, not a piece of in-flight work, and one per project
// would crowd out everything the list exists to show.
//
// A plain function for the same reason as buildSidebarRows: the queries
// belong to the Sidebar, so switching views is free.
export function buildInboxRows({
  projects,
  worktreeQueries,
  pullRequestQueries,
  openShelves,
}: BuildInboxRowsArgs): SidebarViewModel {
  const failedCount = worktreeQueries.filter((q) => q.error).length;
  const loadingCount = worktreeQueries.filter((q) => q.isLoading).length;

  const live: Entry[] = [];
  const shelves: Record<InboxShelf, Entry[]> = { shelved: [], merged: [] };
  // Filed for every shelved worktree, open shelf or not -- it's the
  // folded case that revealKey needs an answer for.
  const shelfOf = new Map<string, InboxShelf>();
  projects.forEach((project, i) => {
    if (project.pathExists === false) return;
    const trees = (worktreeQueries[i]?.data ?? []) as Worktree[];
    const prs = pullRequestQueries[i]?.data;
    for (const worktree of trees) {
      if (worktree.isPrimary) continue;
      const entry: Entry = {
        worktree,
        project,
        pr: prs?.[worktree.branch],
        activityAt: worktreeLastActivityAt(worktree),
      };
      const bucket = bucketFor(worktree, entry.pr);
      if (bucket === "live") {
        live.push(entry);
      } else {
        shelves[bucket].push(entry);
        shelfOf.set(worktree.id, bucket);
      }
    }
  });

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
    emptyMessage:
      total === 0 && loadingCount === 0 && failedCount === 0
        ? "No worktrees yet."
        : null,
    revealKey: (_projectId, worktreeId) => {
      const shelf = shelfOf.get(worktreeId);
      if (shelf && !openShelves.has(shelf)) return `shelf:${shelf}`;
      return rows.some((r) => r.key === `w:${worktreeId}`)
        ? `w:${worktreeId}`
        : null;
    },
  };
}
