import type { MirrorLink } from "@/hooks/remote/useMirrors";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { ProjectWorktreeQueries } from "@/hooks/worktrees/useWorktrees";
import { rankByScore } from "@/lib/fuzzyMatch";
import { isHiddenByPrefix } from "@shared/sharedSettings";
import {
  worktreeLastActivityAt,
  type Project,
  type Worktree,
} from "@shared/schemas";
import {
  deviceBadgeOf,
  mirrorBadgeLookup,
  mirrorPairsOf,
  worktreeRowKey,
} from "@/components/sidebar/buildSidebarRows";
import type { SidebarDeviceBadge } from "@/components/sidebar/DeviceBadge";

// One worktree the palette can land on, wherever it lives.
export interface PaletteEntry {
  // The sidebar's own row key, so a worktree has one identity in both.
  key: string;
  worktree: Worktree;
  project: Project;
  // The peer it lives on. Undefined for this machine's own.
  device: SidebarDeviceBadge | undefined;
  // The peer a local worktree is mirrored with (its peer row folds in).
  mirror: SidebarDeviceBadge | undefined;
  // Matches a hidden-worktree prefix: listed only for a query.
  hidden: boolean;
}

export interface PaletteList {
  entries: PaletteEntry[];
  // The entry standing for a row key: a mirrored peer worktree's is
  // its local copy's, the row it folds into.
  entryKeyOf: (rowKey: string) => string;
}

interface BuildPaletteEntriesArgs {
  projects: Project[];
  // Positionally aligned with `projects`.
  worktreeQueries: ProjectWorktreeQueries;
  remote: RemoteForestItem[];
  mirrors: readonly MirrorLink[];
  deviceBadges: ReadonlyMap<string, SidebarDeviceBadge>;
  hiddenPrefixes: readonly string[];
  // recordWorktreeVisit's record by row key, read once per open.
  visits: Record<string, number>;
}

// Every worktree on every machine as one flat list, the inbox's merge
// without its shelves: shelved, merged and primary checkouts all
// included, since a palette is for finding things, not triage. Where
// you were last leads (this window's visits), and the rest follow by
// their own last activity. Worktrees under a hidden prefix wait for a
// query, the way the sidebar keeps them behind a fold.
export function buildPaletteEntries({
  projects,
  worktreeQueries,
  remote,
  mirrors,
  deviceBadges,
  hiddenPrefixes,
  visits,
}: BuildPaletteEntriesArgs): PaletteList {
  const { peerRowsFolded, peerOfLocal } = mirrorPairsOf(mirrors);
  const mirrorBadgeFor = mirrorBadgeLookup(peerOfLocal, deviceBadges);
  const entries: PaletteEntry[] = [];
  const localIds = new Set<string>();
  const folds = new Map<string, string>();

  projects.forEach((project, i) => {
    const trees = (worktreeQueries[i]?.data ?? []) as Worktree[];
    for (const worktree of trees) {
      localIds.add(worktree.id);
      entries.push({
        key: worktreeRowKey(undefined, worktree.id),
        worktree,
        project,
        device: undefined,
        mirror: mirrorBadgeFor(worktree),
        hidden: isHiddenByPrefix(worktree, hiddenPrefixes),
      });
    }
  });
  for (const item of remote) {
    const device = deviceBadgeOf(item);
    for (const worktree of item.worktrees) {
      const key = worktreeRowKey(item.deviceId, worktree.id);
      // The local row of a mirrored pair stands for both copies.
      const folded = peerRowsFolded.get(key);
      if (folded !== undefined && localIds.has(folded)) {
        folds.set(key, worktreeRowKey(undefined, folded));
        continue;
      }
      entries.push({
        key,
        worktree,
        project: item.project,
        device,
        mirror: undefined,
        hidden: isHiddenByPrefix(worktree, hiddenPrefixes),
      });
    }
  }

  const entryKeyOf = (rowKey: string) => folds.get(rowKey) ?? rowKey;
  // A mirrored pair's visits on either side count for its one entry.
  const lastVisit = new Map<string, number>();
  for (const [rowKey, at] of Object.entries(visits)) {
    const key = entryKeyOf(rowKey);
    lastVisit.set(key, Math.max(lastVisit.get(key) ?? 0, at));
  }
  const visitedAt = (entry: PaletteEntry) => lastVisit.get(entry.key) ?? 0;
  const sorted = entries.toSorted(
    (a, b) =>
      visitedAt(b) - visitedAt(a) ||
      worktreeLastActivityAt(b.worktree) - worktreeLastActivityAt(a.worktree) ||
      a.worktree.name.localeCompare(b.worktree.name),
  );
  return { entries: sorted, entryKeyOf };
}

// The row ↩ lands on when the palette opens. The worktree on screen
// leads the recency order (it was visited last), so opening on it
// would make ⌘K ↩ a no-op; the one before it is where a quick switch
// means to go, the way ⌘⇥ lands on the previous app.
export function initialPaletteKey(
  entries: readonly PaletteEntry[],
  currentKey: string | undefined,
): string {
  const [first, second] = entries;
  if (first?.key === currentKey && second) return second.key;
  return first?.key ?? "";
}

// Best field wins: a query can name the branch, the folder, the
// project (alone or ahead of the branch, "sm feat"), or the device, so
// "thinkpad" narrows to that machine's work. Ties keep the recency
// order, since the sort is stable. No query lists all but the hidden.
export function rankPaletteEntries(
  query: string,
  entries: readonly PaletteEntry[],
): readonly PaletteEntry[] {
  if (!query) return entries.filter((entry) => !entry.hidden);
  return rankByScore(query, entries, ({ worktree, project, device }) => [
    worktree.branch,
    worktree.name,
    `${project.name} ${worktree.branch}`,
    device?.label ?? "",
  ]);
}
