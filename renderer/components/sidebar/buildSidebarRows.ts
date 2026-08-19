import type { ProjectWorktreeQueries } from "@/hooks/worktrees/useWorktrees";
import type { Project, Worktree } from "@shared/schemas";
import type { SidebarRow, SidebarViewModel } from "./sidebarRow";

interface BuildSidebarRowsArgs {
  projects: Project[];
  // Positionally aligned with `projects`.
  worktreeQueries: ProjectWorktreeQueries;
  collapsed: Set<string>;
  shelvedExpanded: Set<string>;
  arrangeMode: boolean;
}

// Flattens `projects` plus their per-project worktree queries into the
// SidebarRow list the virtualizer renders. A plain function, not a hook:
// the queries are subscribed once by the Sidebar and handed to whichever
// builder the active view needs, so flipping views doesn't tear the
// subscriptions down and re-probe git for every project.
//
// No memo, deliberately. The result is O(rows) to rebuild and the inputs
// change whenever anything on screen does, so a cache here would need a
// deep fingerprint to stay correct and would save nothing.
export function buildSidebarRows({
  projects,
  worktreeQueries,
  collapsed,
  shelvedExpanded,
  arrangeMode,
}: BuildSidebarRowsArgs): SidebarViewModel {
  const failedCount = worktreeQueries.filter((q) => q.error).length;

  if (arrangeMode) {
    const rows: SidebarRow[] = projects.map((project) => ({
      kind: "project",
      key: `p:${project.id}`,
      project,
      expanded: false,
    }));
    return {
      rows,
      failedCount,
      emptyMessage: null,
      revealKey: (projectId) => headerKeyIfPresent(rows, projectId),
    };
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
  return {
    rows,
    failedCount,
    // Every project renders a header, so "no rows" here only ever means
    // "no projects" -- which the shell already has its own answer for.
    emptyMessage: null,
    revealKey: (projectId, worktreeId) =>
      rows.some((r) => r.key === `w:${worktreeId}`)
        ? `w:${worktreeId}`
        : // Only a folded project stands in for its worktree. A missing
          // row in an open project means the listing hasn't landed yet,
          // and settling for the header there would mark the reveal done
          // and never scroll to the row once it appears.
          collapsed.has(projectId)
          ? headerKeyIfPresent(rows, projectId)
          : null,
  };
}

// A collapsed project hides its worktree rows, so its header is the
// closest thing there is to reveal.
function headerKeyIfPresent(rows: SidebarRow[], projectId: string) {
  const key = `p:${projectId}`;
  return rows.some((r) => r.key === key) ? key : null;
}
