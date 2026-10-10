// The home page's grid, worked out from what the sidebar and the
// palette already build: the list's project rows under their owners,
// and per project where its tile lands and what its work comes to.
// Kept apart from the page so the proof can drive it
// (test/project-grid.mts).
import type { GroupWork } from "./ProjectGridView.tsx";
import {
  worktreeLastActivityAt,
  type Project,
} from "@shigomori/contracts/schemas/index";
import {
  buildPaletteEntries,
  projectLead,
} from "../palette/buildPaletteEntries.ts";
import type { PaletteEntry } from "../palette/paletteEntries.ts";
import {
  projectGroupKey,
  type ProjectGroupOrder,
} from "../sidebar/buildSidebarRows.ts";
import type { SidebarDeviceBadge } from "../sidebar/DeviceBadgeView.tsx";
import { projectListSections } from "../sidebar/projectListSections.ts";
import type { ProjectSection } from "../sidebar/sidebarRow.ts";
import type { ProjectPullRequestQueries } from "../../lib/forest.ts";
import type { MirrorLink } from "../../lib/forest.ts";
import type { RemoteForestItem } from "../../lib/forest.ts";
import type { ProjectWorktreeQueries } from "../../lib/forest.ts";

export interface GridInput {
  // This machine's projects and their listings, positionally aligned,
  // as the device filter leaves them (forestSources.ts).
  projects: readonly Project[];
  worktreeQueries: ProjectWorktreeQueries;
  pullRequestQueries: ProjectPullRequestQueries;
  order: ProjectGroupOrder;
  hiddenPrefixes: readonly string[];
  allowAgentWorking: boolean;
  byOwner: boolean;
  remote: RemoteForestItem[];
  mirrors: readonly MirrorLink[];
  deviceBadges: ReadonlyMap<string, SidebarDeviceBadge>;
  // recordWorktreeVisit's record by row key.
  visits: Record<string, number>;
}

export function buildGrid({ visits, ...forest }: GridInput): {
  sections: ProjectSection[];
  work: Map<string, GroupWork>;
} {
  const { entries } = buildPaletteEntries({ ...forest, visits });
  return {
    sections: projectListSections(forest),
    work: workByGroup(entries),
  };
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
