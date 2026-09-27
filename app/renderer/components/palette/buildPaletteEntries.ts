import type { MirrorLink } from "@/hooks/remote/useMirrors";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { ProjectPullRequestQueries } from "@/hooks/projects/useProjectPullRequests";
import type { ProjectWorktreeQueries } from "@/hooks/worktrees/useWorktrees";
import { rankByScore } from "@/lib/fuzzyMatch";
import { isCloneableRemote } from "@shared/cloneUrl";
import { sanitizeBranchName } from "@shared/git/branches";
import { isAnchoredPath } from "@shared/projectPaths";
import { isHiddenByPrefix } from "@shared/sharedSettings";
import {
  worktreeLastActivityAt,
  type Project,
  type PullRequest,
  type Worktree,
} from "@shared/schemas";
import {
  deviceBadgeOf,
  mirrorBadgeLookup,
  mirrorPairsOf,
  projectGroupKey,
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
  // The pull request open (or once open) for its branch.
  pr: PullRequest | undefined;
  // Matches a hidden-worktree prefix: listed only for a query.
  hidden: boolean;
  // Merged or shelved: still found, but below the work in progress.
  sunk: boolean;
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
  // Positionally aligned with `projects` too.
  pullRequestQueries: ProjectPullRequestQueries;
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
// their own last activity, merged and shelved ones after all the rest.
// Worktrees under a hidden prefix wait for a query, the way the
// sidebar keeps them behind a fold.
export function buildPaletteEntries({
  projects,
  worktreeQueries,
  pullRequestQueries,
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
    const pullRequests = pullRequestQueries[i]?.data;
    for (const worktree of trees) {
      localIds.add(worktree.id);
      entries.push({
        key: worktreeRowKey(undefined, worktree.id),
        worktree,
        project,
        device: undefined,
        mirror: mirrorBadgeFor(worktree),
        pr: pullRequests?.[worktree.branch],
        hidden: isHiddenByPrefix(worktree, hiddenPrefixes),
        sunk: isSunk(worktree),
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
        pr: item.pullRequests[worktree.branch],
        hidden: isHiddenByPrefix(worktree, hiddenPrefixes),
        sunk: isSunk(worktree),
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
      Number(a.sunk) - Number(b.sunk) ||
      visitedAt(b) - visitedAt(a) ||
      worktreeLastActivityAt(b.worktree) - worktreeLastActivityAt(a.worktree) ||
      a.worktree.name.localeCompare(b.worktree.name),
  );
  return { entries: sorted, entryKeyOf };
}

const isSunk = (worktree: Worktree) =>
  worktree.shelved || worktree.mergedIntoPrimary;

// The row ↩ lands on when the palette opens. The worktree on screen
// leads the recency order (it was visited last), so opening on it
// would make ⌘K ↩ a no-op. The one before it is where a quick switch
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
// project (alone or ahead of the branch, "sm feat"), the device, so
// "thinkpad" narrows to that machine's work, or the pull request, by
// "#148" or its title. Merged and shelved worktrees score at half, so
// they come up for a query that names them and sink under one that
// matches live work as well. Ties keep the recency order, since the
// sort is stable. No query lists all but the hidden.
export function rankPaletteEntries(
  query: string,
  entries: readonly PaletteEntry[],
): readonly PaletteEntry[] {
  if (!query) return entries.filter((entry) => !entry.hidden);
  return rankByScore(
    query,
    entries,
    ({ worktree, project, device, pr }) => [
      worktree.branch,
      worktree.name,
      `${project.name} ${worktree.branch}`,
      device?.label ?? "",
      pr ? `#${pr.number}` : "",
      pr?.title ?? "",
    ],
    (entry) => (entry.sunk ? 0.5 : 1),
  );
}

// A project the query names, standing for its checkouts on every
// device: one row per sidebar group, however many machines hold it.
export interface PaletteProject {
  key: string;
  // Where ↩ goes: its worktree the list would put first.
  lead: PaletteEntry;
  // This device's checkout, when it has one: where a quick create goes.
  localProject: Project | undefined;
  worktreeCount: number;
  deviceCount: number;
}

// The few projects the query names by name, best first. Only for a
// query: unasked, the worktree list already leads with their work.
export function rankPaletteProjects(
  query: string,
  entries: readonly PaletteEntry[],
): PaletteProject[] {
  if (!query) return [];
  const byKey = new Map<string, PaletteEntry[]>();
  for (const entry of entries) {
    const key = projectGroupKey(entry.project, entry.device?.deviceId);
    const group = byKey.get(key);
    if (group) group.push(entry);
    else byKey.set(key, [entry]);
  }
  const projects = [...byKey].map(([key, trees]): PaletteProject => {
    const [first] = trees as [PaletteEntry, ...PaletteEntry[]];
    const lead = trees.find((t) => !t.sunk && !t.hidden) ?? first;
    return {
      key: `project:${key}`,
      lead,
      localProject: trees.find((t) => !t.device)?.project,
      worktreeCount: trees.length,
      deviceCount: new Set(trees.map((t) => t.device?.deviceId)).size,
    };
  });
  return rankByScore(query, projects, (p) => p.lead.project.name).slice(0, 3);
}

// A query as the branch a new worktree would take: the branch inputs'
// own filter (sanitizeBranchName) over it, a run of whitespace as one
// dash, then the ref rules that filter leaves to git: no "..", no
// empty component, none starting with a dot or ending in a dot or
// ".lock", and no leading dash. Null when nothing usable is left.
export function newBranchName(query: string): string | null {
  const name = sanitizeBranchName(query.trim().replace(/\s+/g, "-"))
    .replace(/\.{2,}/g, ".")
    .split("/")
    .map((part) => part.replace(/^\.+/, "").replace(/(\.lock|\.)+$/, ""))
    .filter(Boolean)
    .join("/")
    .replace(/^[-/]+/, "");
  return name || null;
}

// A query that is a path on disk or a repo URL: something pasted,
// never a branch to offer.
export function isProjectSource(query: string): boolean {
  const q = query.trim();
  return isAnchoredPath(q) || isCloneableRemote(q);
}

// The projects a new worktree can go into, the likeliest first: the
// one on screen, then the top match's, then by their latest work.
// Only this device's: a create here is the quick one, and the form
// (one of the create row's verbs) picks another device.
export function createTargets(
  localProjects: readonly Project[],
  shown: readonly PaletteEntry[],
  entries: readonly PaletteEntry[],
  pageProjectId: string | undefined,
): Project[] {
  const order = [
    pageProjectId,
    ...shown.filter((e) => !e.device).map((e) => e.worktree.projectId),
    ...entries.filter((e) => !e.device).map((e) => e.worktree.projectId),
    ...localProjects.map((p) => p.id),
  ];
  // A project whose folder is gone has nowhere to put one.
  const byId = new Map(
    localProjects.filter((p) => p.pathExists !== false).map((p) => [p.id, p]),
  );
  const seen = new Set<string>();
  const targets: Project[] = [];
  for (const id of order) {
    const project = id === undefined ? undefined : byId.get(id);
    if (!project || seen.has(project.id)) continue;
    seen.add(project.id);
    targets.push(project);
  }
  return targets;
}
