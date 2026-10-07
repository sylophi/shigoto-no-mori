// The home page's grid, worked out from what the sidebar and the
// palette already build: the list's project rows under their owners,
// and per project where its tile lands and what its work comes to.
// Kept apart from the page so the proof can drive it
// (test/project-grid.mts).
import { worktreeLastActivityAt, type Project } from "@shared/schemas";
import {
  buildPaletteEntries,
  projectLead,
  type PaletteEntry,
} from "@/components/palette/buildPaletteEntries";
import {
  buildSidebarRows,
  projectGroupKey,
  type ProjectGroupOrder,
} from "@/components/sidebar/buildSidebarRows";
import type { SidebarDeviceBadge } from "@/components/sidebar/DeviceBadge";
import type { SidebarRow } from "@/components/sidebar/sidebarRow";
import type { ProjectPullRequestQueries } from "@/hooks/projects/useProjectPullRequests";
import type { MirrorLink } from "@/hooks/remote/useMirrors";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { ProjectWorktreeQueries } from "@/hooks/worktrees/useWorktrees";

export type ProjectTileRow = Extract<SidebarRow, { kind: "project" }>;

export interface Section {
  key: string;
  // The owner's name, null for a list that isn't split.
  label: string | null;
  rows: ProjectTileRow[];
}

// What a tile says about its project's work, off the palette's entries.
export interface GroupWork {
  // Where the tile lands (projectLead): the worktree visited last,
  // else the one worked in last.
  lead: PaletteEntry | undefined;
  lastActivity: number;
  openPullRequests: number;
}

export interface GridInput {
  // This machine's projects and their listings, positionally aligned,
  // as the device filter leaves them (forestSources.ts).
  projects: readonly Project[];
  worktreeQueries: ProjectWorktreeQueries;
  pullRequestQueries: ProjectPullRequestQueries;
  order: ProjectGroupOrder;
  hiddenPrefixes: readonly string[];
  byOwner: boolean;
  remote: RemoteForestItem[];
  mirrors: readonly MirrorLink[];
  deviceBadges: ReadonlyMap<string, SidebarDeviceBadge>;
  // recordWorktreeVisit's record by row key.
  visits: Record<string, number>;
}

const NO_SHELVES = { shelved: new Set<string>(), hidden: new Set<string>() };

export function buildGrid({ visits, byOwner, ...forest }: GridInput): {
  sections: Section[];
  work: Map<string, GroupWork>;
} {
  // The tree's list of projects, every owner open.
  const { rows } = buildSidebarRows({
    ...forest,
    openKey: null,
    // Only an open project's rows are sorted.
    worktreeSort: "name",
    openShelves: NO_SHELVES,
    arrangeMode: false,
    byOwner: byOwner ? { shut: new Set() } : null,
  });
  const { entries } = buildPaletteEntries({ ...forest, visits });
  return { sections: sectionsOf(rows), work: workByGroup(entries) };
}

// The list's project rows under their owners. The owner headers come
// before their projects (ownerSections), and a list that isn't split
// has none, so it is one unnamed section.
function sectionsOf(rows: readonly SidebarRow[]): Section[] {
  const sections: Section[] = [];
  for (const row of rows) {
    if (row.kind === "owner-header") {
      sections.push({ key: row.key, label: row.label, rows: [] });
    } else if (row.kind === "project") {
      const last = sections.at(-1);
      if (last) last.rows.push(row);
      else sections.push({ key: "all", label: null, rows: [row] });
    }
  }
  return sections;
}

// Each project's entries, in the palette's order, by the group key its
// tile goes by.
function workByGroup(entries: readonly PaletteEntry[]): Map<string, GroupWork> {
  const groups = new Map<string, PaletteEntry[]>();
  for (const entry of entries) {
    const key = projectGroupKey(entry.project, entry.device?.deviceId);
    const trees = groups.get(key);
    if (trees) trees.push(entry);
    else groups.set(key, [entry]);
  }
  return new Map(
    [...groups].map(([key, trees]) => {
      const shown = trees.filter((entry) => !entry.hidden);
      const prs = new Set(
        shown.flatMap((entry) =>
          entry.pr?.state === "OPEN" ? [entry.pr.number] : [],
        ),
      );
      return [
        key,
        {
          lead: projectLead(trees),
          lastActivity: Math.max(
            0,
            ...shown.map((entry) => worktreeLastActivityAt(entry.worktree)),
          ),
          openPullRequests: prs.size,
        },
      ];
    }),
  );
}
