import type { MirrorLink } from "@/hooks/remote/useMirrors";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { ProjectWorktreeQueries } from "@/hooks/worktrees/useWorktrees";
import { scoreMatch } from "@/lib/fuzzyMatch";
import { worktreeVisitKey } from "@/lib/recentWorktrees";
import {
  worktreeLastActivityAt,
  type Project,
  type Worktree,
} from "@shared/schemas";
import {
  deviceBadgeOf,
  mirrorBadgeLookup,
  mirrorPairsOf,
  remoteWorktreeKey,
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
}

// The sidebar's row key for a worktree on a peer (deviceId) or here.
export function paletteEntryKey(
  deviceId: string | undefined,
  worktreeId: string,
): string {
  return deviceId === undefined
    ? `w:${worktreeId}`
    : remoteWorktreeKey(deviceId, worktreeId);
}

interface BuildPaletteEntriesArgs {
  projects: Project[];
  // Positionally aligned with `projects`.
  worktreeQueries: ProjectWorktreeQueries;
  remote: RemoteForestItem[];
  mirrors: readonly MirrorLink[];
  deviceBadges: ReadonlyMap<string, SidebarDeviceBadge>;
  // recordWorktreeVisit's record, read once when the palette opens.
  visits: Record<string, number>;
}

// Every worktree on every machine as one flat list, the inbox's merge
// without its shelves: shelved, merged and primary checkouts all
// included, since a palette is for finding things, not triage. Where
// you were last leads (this window's visits), and the rest follow by
// their own last activity.
export function buildPaletteEntries({
  projects,
  worktreeQueries,
  remote,
  mirrors,
  deviceBadges,
  visits,
}: BuildPaletteEntriesArgs): PaletteEntry[] {
  const { peerRowsFolded, peerOfLocal } = mirrorPairsOf(mirrors);
  const mirrorBadgeFor = mirrorBadgeLookup(peerOfLocal, deviceBadges);
  const entries: PaletteEntry[] = [];
  const localIds = new Set<string>();

  projects.forEach((project, i) => {
    const trees = (worktreeQueries[i]?.data ?? []) as Worktree[];
    for (const worktree of trees) {
      localIds.add(worktree.id);
      entries.push({
        key: paletteEntryKey(undefined, worktree.id),
        worktree,
        project,
        device: undefined,
        mirror: mirrorBadgeFor(worktree),
      });
    }
  });
  for (const item of remote) {
    const device = deviceBadgeOf(item);
    for (const worktree of item.worktrees) {
      const key = paletteEntryKey(item.deviceId, worktree.id);
      // The local row of a mirrored pair stands for both copies.
      const folded = peerRowsFolded.get(key);
      if (folded !== undefined && localIds.has(folded)) continue;
      entries.push({
        key,
        worktree,
        project: item.project,
        device,
        mirror: undefined,
      });
    }
  }

  const visitedAt = (entry: PaletteEntry) =>
    visits[worktreeVisitKey(entry.device?.deviceId, entry.worktree.id)] ?? 0;
  return entries.toSorted(
    (a, b) =>
      visitedAt(b) - visitedAt(a) ||
      worktreeLastActivityAt(b.worktree) - worktreeLastActivityAt(a.worktree) ||
      a.worktree.name.localeCompare(b.worktree.name),
  );
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
// order, since the sort is stable.
export function rankPaletteEntries(
  query: string,
  entries: readonly PaletteEntry[],
): readonly PaletteEntry[] {
  if (!query) return entries;
  const scored: { entry: PaletteEntry; score: number }[] = [];
  for (const entry of entries) {
    const { worktree, project, device } = entry;
    const score = Math.max(
      scoreMatch(query, worktree.branch),
      scoreMatch(query, worktree.name),
      scoreMatch(query, `${project.name} ${worktree.branch}`),
      device ? scoreMatch(query, device.label) : 0,
    );
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.entry);
}
