import type { RemoteForestEntry } from "@/hooks/remote/useRemoteForests";
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
  // Peer devices' forests, merged into the tree: a remote project
  // sharing a local project's repo identity contributes its worktrees
  // to that group (marked per row), the rest gather under
  // remote-project headers after the local projects.
  remote: RemoteForestEntry[];
}

// One remote project's flattened slice, the unit the merge consumes.
interface RemoteItem {
  deviceId: string;
  deviceLabel: string;
  project: Project;
  worktrees: Worktree[];
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
  remote,
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

  // Shelving is a local noise-control preference; a peer's shelved
  // worktrees stay in its own sidebar, not this one's.
  const remoteItems: RemoteItem[] = remote
    .flatMap((entry) =>
      entry.projects.map((project) => ({
        deviceId: entry.deviceId,
        deviceLabel: entry.deviceLabel,
        project,
        worktrees: (entry.worktreesByProject.get(project.id) ?? []).filter(
          (worktree) => !worktree.shelved,
        ),
      })),
    )
    .filter((item) => item.worktrees.length > 0);
  const consumed = new Set<RemoteItem>();

  const rows: SidebarRow[] = [];
  projects.forEach((project, i) => {
    const expanded = !collapsed.has(project.id);
    rows.push({
      kind: "project",
      key: `p:${project.id}`,
      project,
      expanded,
    });
    // Claimed by identity even while collapsed or still loading, so a
    // folded project's remote worktrees fold with it instead of
    // reappearing below as a duplicate remote-project group. A missing
    // local project claims nothing: its remote counterpart is alive and
    // belongs under its own header.
    const remoteHere =
      project.pathExists === false || project.identity == null
        ? []
        : remoteItems.filter(
            (item) => item.project.identity === project.identity,
          );
    for (const item of remoteHere) consumed.add(item);
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
    // Peers' worktrees of this same repo, after the local rows so the
    // local work stays where the eye expects it. The shelved section
    // keeps its anchor at the very bottom of the group.
    for (const item of remoteHere) {
      pushRemoteWorktreeRows(rows, item, project.id);
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

  // Remote projects with no local counterpart, after the local tree.
  // Grouped by repo identity so the same repo on several devices reads
  // as one project (the per-row device marker tells them apart); an
  // identity-less project can only group with itself.
  const leftoverGroups = new Map<string, RemoteItem[]>();
  for (const item of remoteItems) {
    if (consumed.has(item)) continue;
    const groupKey =
      item.project.identity ?? `${item.deviceId}/${item.project.id}`;
    const group = leftoverGroups.get(groupKey);
    if (group) group.push(item);
    else leftoverGroups.set(groupKey, [item]);
  }
  for (const [groupKey, items] of leftoverGroups) {
    const groupId = `rp:${groupKey}`;
    rows.push({
      kind: "remote-project",
      key: groupId,
      name: items[0]?.project.name ?? "",
      count: items.reduce((sum, item) => sum + item.worktrees.length, 0),
      groupId,
    });
    for (const item of items) {
      pushRemoteWorktreeRows(rows, item, groupId);
    }
  }

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

function pushRemoteWorktreeRows(
  rows: SidebarRow[],
  item: RemoteItem,
  groupId: string,
): void {
  for (const worktree of item.worktrees) {
    rows.push({
      kind: "remote-worktree",
      // Device-qualified: the same repo pulled to two machines can
      // carry the same worktree id on both.
      key: `rw:${item.deviceId}:${worktree.id}`,
      worktree,
      deviceId: item.deviceId,
      deviceLabel: item.deviceLabel,
      groupId,
    });
  }
}
