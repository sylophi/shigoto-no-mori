import type { MirrorLink } from "@/hooks/remote/useMirrors";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { ProjectPullRequestQueries } from "@/hooks/projects/useProjectPullRequests";
import type { ProjectWorktreeQueries } from "@/hooks/worktrees/useWorktrees";
import { rankByScore, scoreFields } from "@/lib/fuzzyMatch";
import type { LucideIcon } from "lucide-react";
import { isCloneableRemote } from "@shared/cloneUrl";
import { sanitizeBranchName } from "@shared/git/branches";
import { isAnchoredPath } from "@shared/projectPaths";
import { isHiddenByPrefix } from "@shared/sharedSettings";
import {
  isAgentWorking,
  worktreeLastActivityAt,
  type Project,
  type PullRequest,
  type Worktree,
} from "@shared/schemas";
import {
  deviceBadgeOf,
  mirrorBadgeLookup,
  mirrorPairsOf,
  ownerOf,
  projectGroupKey,
  worktreeRowKey,
} from "@/components/sidebar/buildSidebarRows";
import type { SidebarDeviceBadge } from "@/components/sidebar/DeviceBadge";
import { worktreeTitle } from "@/lib/worktreeTitle";

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
  // Merged, shelved or agent working: still found, but below the work in
  // progress.
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
  // Whether a working agent session shelves its worktree (isAgentWorking).
  allowAgentWorking: boolean;
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
  allowAgentWorking,
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
        sunk: isSunk(worktree, allowAgentWorking),
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
        sunk: isSunk(worktree, allowAgentWorking),
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

const isSunk = (worktree: Worktree, allowAgentWorking: boolean) =>
  isAgentWorking(worktree, allowAgentWorking) ||
  worktree.shelved ||
  worktree.mergedIntoPrimary;

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

// Best field wins: a query can name the branch, its title, the folder, the
// project (alone or ahead of the branch, "sm feat"), the device, so
// "thinkpad" narrows to that machine's work, the project's owner, so
// an org's name narrows to its work, or the pull request, by
// "#148" or its title. Merged and shelved worktrees score at half, so
// they come up for a query that names them and sink under one that
// matches live work as well. Ties keep the recency order, since the
// sort is stable. No query lists all but the hidden.
export function rankPaletteEntries(
  query: string,
  entries: readonly PaletteEntry[],
): readonly PaletteEntry[] {
  if (!query) return entries.filter((entry) => !entry.hidden);
  return rankByScore(query, entries, entryFields, entryWeight);
}

const entryFields = ({ worktree, project, device, pr }: PaletteEntry) => [
  worktree.branch,
  worktreeTitle(worktree, pr) ?? "",
  worktree.name,
  `${project.name} ${worktree.branch}`,
  device?.label ?? "",
  ...ownerNames(project),
  pr ? `#${pr.number}` : "",
  pr?.title ?? "",
];

const entryWeight = (entry: PaletteEntry) => (entry.sunk ? 0.5 : 1);

// A project the query names, standing for its checkouts on every
// device: one row per sidebar group, however many machines hold it.
export interface PaletteProject {
  key: string;
  // The checkout the row names: this device's when it has one.
  project: Project;
  // The peer that checkout is on. Undefined for this machine's own.
  device: SidebarDeviceBadge | undefined;
  // Where ↩ goes: its worktree the list would put first. Undefined
  // for a project with none, whose ↩ is its new-worktree page.
  lead: PaletteEntry | undefined;
  // This device's checkout, when it has one: where a quick create goes.
  localProject: Project | undefined;
  worktreeCount: number;
  deviceCount: number;
}

// Where a project opens, here and on its home page tile
// (home/gridModel.ts): of its worktrees in the list's order, the first
// that isn't shelved, merged or hidden, one on a device that can be
// reached before one on a device that can't, else the first. Undefined
// for a project with none.
export function projectLead(
  trees: readonly PaletteEntry[],
): PaletteEntry | undefined {
  const open = trees.filter((t) => !t.sunk && !t.hidden);
  return open.find((t) => t.device?.reachable !== false) ?? open[0] ?? trees[0];
}

// What a project answers to: its name, and its remote's owner (the
// sidebar's owner headers, ownerOf), alone or ahead of the repo
// ("sylophi/web"). Its worktrees answer to the owner too.
export function projectNames(project: Project): string[] {
  return [project.name, ...ownerNames(project)];
}

function ownerNames(project: Project): string[] {
  const owner = ownerOf(project);
  return owner ? [owner.name, `${owner.name}/${owner.repo}`] : [];
}

// The few projects the query names, best first, and all of an owner's
// when it is the owner's name. Every project
// on every device, the ones with no worktrees too, since the sidebar's
// list of projects is the other way to them. Not one whose folder is
// gone, which the sidebar won't open either. Only for a query:
// unasked, the worktree list already leads with their work.
export function rankPaletteProjects(
  query: string,
  entries: readonly PaletteEntry[],
  projects: readonly Project[],
  remote: readonly RemoteForestItem[],
): PaletteProject[] {
  if (!query) return [];
  const groups = new Map<
    string,
    {
      project: Project;
      device: SidebarDeviceBadge | undefined;
      trees: PaletteEntry[];
      devices: Set<string | undefined>;
    }
  >();
  // This device's projects first, so a group names its local checkout.
  // A repo only peers hold is named by a reachable one, where its
  // pages open.
  const join = (project: Project, device: SidebarDeviceBadge | undefined) => {
    const key = projectGroupKey(project, device?.deviceId);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        project,
        device,
        trees: [],
        devices: new Set([device?.deviceId]),
      });
      return;
    }
    group.devices.add(device?.deviceId);
    if (group.device && !group.device.reachable && device?.reachable) {
      group.project = project;
      group.device = device;
    }
  };
  for (const project of projects) {
    if (project.pathExists !== false) join(project, undefined);
  }
  for (const item of remote) join(item.project, deviceBadgeOf(item));
  for (const entry of entries) {
    const key = projectGroupKey(entry.project, entry.device?.deviceId);
    groups.get(key)?.trees.push(entry);
  }
  const items = [...groups].map(
    ([key, { project, device, trees, devices }]): PaletteProject => ({
      key: `project:${key}`,
      project,
      device,
      lead: projectLead(trees),
      localProject: device ? undefined : project,
      worktreeCount: trees.length,
      deviceCount: devices.size,
    }),
  );
  const ranked = rankByScore(query, items, (p) => projectNames(p.project));
  const owner = query.toLowerCase();
  return ranked.filter(
    (p, i) =>
      i < PROJECTS_SHOWN || ownerOf(p.project)?.name.toLowerCase() === owner,
  );
}

const PROJECTS_SHOWN = 3;

// How many of the ranked projects or pages go above the worktrees:
// those the query names at least as well as the top worktree, so
// typing a project's name finds the project, not its first worktree,
// and a project the letters only scatter through stays under a
// worktree that spells them. A worktree's "project branch" field is
// the longer, so a project name matching in both leads.
export function leadingCount<T>(
  query: string,
  ranked: readonly T[],
  fields: (item: T) => readonly string[],
  shown: readonly PaletteEntry[],
): number {
  const [entry] = shown;
  if (!entry) return ranked.length;
  const top = scoreFields(query, entryFields(entry)) * entryWeight(entry);
  const trailing = ranked.findIndex(
    (item) => scoreFields(query, fields(item)) < top,
  );
  return trailing < 0 ? ranked.length : trailing;
}

// A page of the app the query names: one the sidebar's footer leads to,
// or a section of Settings.
export interface PalettePage {
  key: string;
  label: string;
  icon: LucideIcon;
  // Settings, for a section of it: where the row says it is, and what
  // the query can name it by too ("settings appearance").
  parent?: string;
  // What else it goes by ("Devices" for the account).
  aliases?: readonly string[];
  open: () => void;
}

export const pageFields = ({ label, parent, aliases = [] }: PalettePage) =>
  parent ? [label, ...aliases, `${parent} ${label}`] : [label, ...aliases];

// The pages the query names, best first. Only for a query: unasked,
// the list is the worktrees.
export function rankPalettePages(
  query: string,
  pages: readonly PalettePage[],
): readonly PalettePage[] {
  if (!query) return [];
  return rankByScore(query, pages, pageFields);
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
