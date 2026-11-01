// The tree's list of projects as sections: its project rows under
// their owners and their folders, in its order, the pinned projects
// leading them as a section of their own. What the home page's grid and
// the inbox's New worktree menu list, so neither can disagree with the tree about
// what there is or where it sits.
import type { ProjectSection } from "./sidebarRow.ts";
import { type ProjectListArgs, projectHeaders } from "./buildSidebarRows.ts";
import { groupSections } from "./projectGroupOrder.ts";

export function projectListSections(forest: ProjectListArgs): ProjectSection[] {
  const { pinned, runs } = groupSections(
    projectHeaders(forest),
    (row) => row,
    forest.order,
  );
  // A folder's section names its owner too, and the owner's projects in
  // no folder follow its folders.
  const sections: ProjectSection[] =
    pinned.length > 0 ? [{ key: "pinned", label: null, rows: pinned }] : [];
  for (const { owner, folders, loose } of runs) {
    for (const { name, headerKey, items } of folders)
      sections.push({
        key: headerKey,
        label: owner === null ? name : `${owner.label} / ${name}`,
        folder: name,
        rows: items,
      });
    if (loose.length > 0)
      sections.push({
        key: owner?.headerKey ?? "all",
        label: owner?.label ?? null,
        rows: loose,
      });
  }
  return sections;
}
