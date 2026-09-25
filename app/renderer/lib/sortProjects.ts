import { assertNever } from "@/lib/utils";
import type { Project, ProjectSortMode } from "@shared/schemas";

// Orders the sidebar project list for display. `manual` preserves the stored
// (drag-arranged) order; the usage sorts read the `lastUsed` / `recentCount`
// fields populated by the projects:list handler. Mirrors the package.json
// scripts sort in sortPackageScripts.ts.
export function sortProjects(
  projects: Project[],
  mode: ProjectSortMode,
): Project[] {
  return sortByProject(projects, mode, (project) => project);
}

// The same orders over anything that stands for a project, so the tree
// can sort its groups (a peer-only project among the local ones) by
// the one rule.
export function sortByProject<T>(
  items: T[],
  mode: ProjectSortMode,
  projectOf: (item: T) => Project,
): T[] {
  const byName = (a: T, b: T) =>
    projectOf(a).name.localeCompare(projectOf(b).name);
  // Highest usage first, the name breaking ties.
  const byUsage = (field: "lastUsed" | "recentCount") => (a: T, b: T) => {
    const diff = (projectOf(b)[field] ?? 0) - (projectOf(a)[field] ?? 0);
    return diff !== 0 ? diff : byName(a, b);
  };
  switch (mode) {
    case "manual":
      return items;
    case "alphabetical":
      return items.toSorted(byName);
    case "recent":
      return items.toSorted(byUsage("lastUsed"));
    case "frequent":
      return items.toSorted(byUsage("recentCount"));
    default:
      return assertNever(mode);
  }
}
