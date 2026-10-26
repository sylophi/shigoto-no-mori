// The tree's list of projects as sections: its project rows under
// their owners and their folders, in its order, the pinned projects
// leading them as a section of their own. What the home page's grid and
// the inbox's New worktree menu list, so neither can disagree with the tree about
// what there is or where it sits.
import type { ProjectSection } from "./sidebarRow.ts";

import {
  buildSidebarRows,
  type BuildSidebarRowsArgs,
} from "./buildSidebarRows.ts";

const NO_SHELVES = {
  agentWorking: new Set<string>(),
  shelved: new Set<string>(),
  hidden: new Set<string>(),
};

export function projectListSections({
  byOwner,
  ...forest
}: Omit<
  BuildSidebarRowsArgs,
  | "openKey"
  | "inline"
  | "worktreeSort"
  | "openShelves"
  | "byPrefix"
  | "arrangeMode"
  | "byOwner"
  | "shutFolders"
> & { byOwner: boolean }): ProjectSection[] {
  // The list of projects, every owner and folder open.
  const { rows } = buildSidebarRows({
    ...forest,
    openKey: null,
    inline: null,
    // Only an open project's rows are sorted.
    worktreeSort: () => "name",
    openShelves: NO_SHELVES,
    // Only an open project's rows are grouped.
    byPrefix: null,
    arrangeMode: false,
    byOwner: byOwner ? { shut: new Set() } : null,
    shutFolders: new Set(),
  });
  // The owner and folder headers come before their projects
  // (ownerSections, folderRuns), and a list that isn't split has none,
  // so it is one unnamed section. The pinned projects leading them are
  // an unnamed one of their own. A folder's section names its owner
  // too, and the owner's projects in no folder follow its folders.
  const sections: ProjectSection[] = [];
  let owner: { key: string; label: string } | null = null;
  for (const row of rows) {
    if (row.kind === "owner-header") {
      owner = row;
    } else if (row.kind === "project-folder") {
      sections.push({
        key: row.key,
        label: owner === null ? row.name : `${owner.label} / ${row.name}`,
        folder: row.name,
        rows: [],
      });
    } else if (row.kind === "project") {
      const last = sections.at(-1);
      const key = row.pinned ? "pinned" : (owner?.key ?? "all");
      if (last && (row.nested || last.key === key)) last.rows.push(row);
      else
        sections.push({
          key,
          label: row.pinned ? null : (owner?.label ?? null),
          rows: [row],
        });
    }
  }
  return sections;
}
