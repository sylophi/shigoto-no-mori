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
  switch (mode) {
    case "manual":
      return projects;
    case "alphabetical":
      return projects.toSorted((a, b) => a.name.localeCompare(b.name));
    case "recent":
      return projects.toSorted((a, b) => {
        const diff = (b.lastUsed ?? 0) - (a.lastUsed ?? 0);
        return diff !== 0 ? diff : a.name.localeCompare(b.name);
      });
    case "frequent":
      return projects.toSorted((a, b) => {
        const diff = (b.recentCount ?? 0) - (a.recentCount ?? 0);
        return diff !== 0 ? diff : a.name.localeCompare(b.name);
      });
    default:
      return assertNever(mode);
  }
}
