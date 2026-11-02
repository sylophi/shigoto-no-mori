// The home page's grid, worked out from what the sidebar and the
// palette already build: the list's project rows under their owners,
// and per project where its tile lands and what its work comes to.
import type { GroupWork } from "./ProjectGridView.tsx";
import { worktreeLastActivityAt } from "@shigomori/contracts/schemas";
import {
  buildPaletteEntries,
  projectGroups,
  projectLead,
  type ProjectGroupEntries,
} from "../palette/buildPaletteEntries.ts";
import type { SidebarDeviceBadge } from "../sidebar/DeviceBadgeView.tsx";
import { projectListSections } from "../sidebar/projectListSections.ts";
import type { ProjectSection } from "../sidebar/sidebarRow.ts";
import type { ProjectListArgs } from "../sidebar/buildSidebarRows.ts";

export type GridInput = ProjectListArgs & {
  deviceBadges: ReadonlyMap<string, SidebarDeviceBadge>;
  // recordWorktreeVisit's record by row key.
  visits: Record<string, number>;
};

export function buildGrid({
  items,
  deviceBadges,
  visits,
  ...forest
}: GridInput): {
  sections: ProjectSection[];
  work: Map<string, GroupWork>;
} {
  const { entries } = buildPaletteEntries({
    items,
    mirrors: forest.mirrors,
    deviceBadges,
    hiddenPrefixes: forest.hiddenPrefixes,
    allowAgentWorking: forest.allowAgentWorking,
    visits,
  });
  return {
    sections: projectListSections({ items, ...forest }),
    work: workByGroup(projectGroups(entries, items)),
  };
}

// Each project group's work, by the group key its tile goes by.
function workByGroup(
  groups: ReadonlyMap<string, ProjectGroupEntries>,
): Map<string, GroupWork> {
  return new Map(
    [...groups].map(([key, { project, device, trees }]) => {
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
          project,
          device,
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
