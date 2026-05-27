import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import type { Project, Worktree } from "@shared/schemas";
import type { SidebarRow } from "./sidebarRow";

interface UseSidebarRowsArgs {
  projects: Project[];
  collapsed: Set<string>;
  shelvedExpanded: Set<string>;
  arrangeMode: boolean;
}

interface UseSidebarRowsResult {
  rows: SidebarRow[];
  failedCount: number;
}

// Flattens `projects` plus their per-project worktree queries into the
// SidebarRow list the virtualizer renders. Mirrors the original inline
// derivation so we keep its render-on-every-change semantics; useQueries
// returns a fresh array each render and a useMemo here would need a
// deep fingerprint to stay correct.
export function useSidebarRows({
  projects,
  collapsed,
  shelvedExpanded,
  arrangeMode,
}: UseSidebarRowsArgs): UseSidebarRowsResult {
  const worktreeQueries = useAllProjectWorktrees(projects, true);
  const failedCount = worktreeQueries.filter((q) => q.error).length;

  if (arrangeMode) {
    const rows: SidebarRow[] = projects.map((project) => ({
      kind: "project",
      key: `p:${project.id}`,
      project,
      expanded: false,
    }));
    return { rows, failedCount };
  }

  const rows: SidebarRow[] = [];
  projects.forEach((project, i) => {
    const expanded = !collapsed.has(project.id);
    rows.push({
      kind: "project",
      key: `p:${project.id}`,
      project,
      expanded,
    });
    if (!expanded || project.pathExists === false) return;
    const query = worktreeQueries[i];
    if (!query) return;
    if (query.isLoading) {
      rows.push({
        kind: "worktree-skeleton",
        key: `sk:${project.id}`,
        projectId: project.id,
      });
      return;
    }
    if (query.error) {
      rows.push({
        kind: "worktree-error",
        key: `err:${project.id}`,
        projectId: project.id,
      });
      return;
    }
    const trees = (query.data ?? []) as Worktree[];
    const visible = trees.filter((w) => !w.shelved);
    const shelved = trees.filter((w) => w.shelved);
    for (const worktree of visible) {
      rows.push({
        kind: "worktree",
        key: `w:${worktree.id}`,
        worktree,
      });
    }
    if (shelved.length > 0) {
      const shelfOpen = shelvedExpanded.has(project.id);
      if (shelfOpen) {
        for (const worktree of shelved) {
          rows.push({
            kind: "worktree",
            key: `w:${worktree.id}`,
            worktree,
          });
        }
      }
      // Always anchored at the bottom of the project's section:
      // "N shelved" reveals, "Hide shelved" collapses.
      rows.push({
        kind: "shelved-toggle",
        key: `shelf:${project.id}`,
        projectId: project.id,
        count: shelved.length,
        expanded: shelfOpen,
      });
    }
  });
  return { rows, failedCount };
}
