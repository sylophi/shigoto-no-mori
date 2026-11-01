import { assertNever } from "./utils.ts";
import type { Project, ProjectSortMode } from "@shigomori/contracts/schemas";

// Orders the sidebar project list for display. `manual` preserves the
// stored (drag-arranged) order, and the usage sorts read the `lastUsed`
// and `recentCount` fields populated by the projects:list handler.
// Mirrors the package.json scripts sort in sortPackageScripts.ts.
export function sortProjects(
  projects: readonly Project[],
  mode: ProjectSortMode,
): readonly Project[] {
  return sortByProject(projects, mode, (project) => project);
}

// The same orders over anything that stands for a project, so the tree
// can sort its groups (a peer-only project among the local ones) by
// the one rule.
export function sortByProject<T>(
  items: readonly T[],
  mode: ProjectSortMode,
  projectOf: (item: T) => Project,
): readonly T[] {
  const byName = (a: T, b: T) =>
    projectOf(a).name.localeCompare(projectOf(b).name);
  switch (mode) {
    case "manual":
      return items;
    case "alphabetical":
      return items.toSorted(byName);
    case "recent":
      return items.toSorted(byUsage("lastUsed", projectOf, byName));
    case "frequent":
      return items.toSorted(byUsage("recentCount", projectOf, byName));
    default:
      return assertNever(mode);
  }
}

// Most-used first by one usage figure, ties by name: the order projects
// and package.json scripts share.
export function byUsage<T>(
  field: "lastUsed" | "recentCount",
  usageOf: (
    item: T,
  ) =>
    | { readonly lastUsed?: number; readonly recentCount?: number }
    | undefined,
  byName: (a: T, b: T) => number,
): (a: T, b: T) => number {
  return (a, b) => {
    const diff = (usageOf(b)?.[field] ?? 0) - (usageOf(a)?.[field] ?? 0);
    return diff !== 0 ? diff : byName(a, b);
  };
}
