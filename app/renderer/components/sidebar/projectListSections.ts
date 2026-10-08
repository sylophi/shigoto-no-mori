// The tree's list of projects as sections: its project rows under
// their owners, in its order, the pinned projects leading them as a
// section of their own. What the home page's grid and the inbox's
// New worktree menu list, so neither can disagree with the tree about
// what there is or where it sits.
import {
  buildSidebarRows,
  type BuildSidebarRowsArgs,
} from "./buildSidebarRows";
import type { SidebarRow } from "./sidebarRow";

export type ProjectListRow = Extract<SidebarRow, { kind: "project" }>;

export interface ProjectSection {
  key: string;
  // The owner's name, null for the pinned projects and for a list that
  // isn't split.
  label: string | null;
  rows: ProjectListRow[];
}

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
> & { byOwner: boolean }): ProjectSection[] {
  // The list of projects, every owner open.
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
  });
  // The owner headers come before their projects (ownerSections), and
  // a list that isn't split has none, so it is one unnamed section. The
  // pinned projects leading them are an unnamed one of their own.
  const sections: ProjectSection[] = [];
  for (const row of rows) {
    if (row.kind === "owner-header") {
      sections.push({ key: row.key, label: row.label, rows: [] });
    } else if (row.kind === "project") {
      const last = sections.at(-1);
      const lastRow = last?.rows.at(-1);
      if (last && (lastRow === undefined || lastRow.pinned === row.pinned))
        last.rows.push(row);
      else
        sections.push({
          key: row.pinned ? "pinned" : "all",
          label: null,
          rows: [row],
        });
    }
  }
  return sections;
}
