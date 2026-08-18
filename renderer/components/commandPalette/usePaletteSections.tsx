import type { ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  FileDiff,
  FolderPlus,
  GitBranch,
  GitBranchPlus,
  LayoutGrid,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import { LauncherIcon } from "@/components/LauncherIcon";
import { sortProjects } from "@/components/sidebar/sortProjects";
import {
  useLaunch,
  useLauncherForProject,
} from "@/hooks/launchers/useLaunchers";
import { useProjects } from "@/hooks/projects/useProjects";
import { useProjectSort } from "@/hooks/projects/useProjectSort";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { useSetShelved } from "@/hooks/worktrees/useWorktreeMutations";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import { getRecentWorktree } from "@/lib/recentWorktrees";
import { router } from "@/router";
import type { Project, Worktree } from "@shared/schemas";
import {
  rankItems,
  type PaletteContext,
  type PaletteItem,
  type PaletteSection,
} from "./paletteModel";

export interface PaletteModel {
  sections: PaletteSection[];
  isLoading: boolean;
  hasProjects: boolean;
}

// Assembles every row the palette can show, in the order an untouched
// palette should read: worktrees first (the headline job is switching
// between 3-10 parallel ones), then projects, then actions.
//
// Everything here is derived per render rather than memoized — same call
// as useSidebarRows, which flattens the identical fan-out. The queries
// share cache keys with the always-mounted sidebar, so opening the
// palette costs no new IPC.
export function usePaletteSections(
  query: string,
  context: PaletteContext,
  close: () => void,
): PaletteModel {
  const projectsQuery = useProjects();
  const projects = projectsQuery.data ?? [];
  const { data: sortMode = "manual" } = useProjectSort();
  const worktreeQueries = useAllProjectWorktrees(projects);
  const { data: launcher } = useLauncherForProject(context.projectId);
  const { openAddProject, toggleLauncher } = useOverlays();
  const setShelved = useSetShelved();
  const launch = useLaunch();

  // useAllProjectWorktrees returns results positionally against the array
  // it was handed, so index them back before any sorting reorders things.
  const worktreesByProject = new Map<string, Worktree[]>();
  projects.forEach((project, i) => {
    worktreesByProject.set(project.id, worktreeQueries[i]?.data ?? []);
  });

  // Base order is the user's sidebar sort, but the project they're
  // standing in comes first: its worktrees are the ones they're most
  // likely bouncing between.
  const ordered = sortProjects(projects, sortMode);
  const projectOrder = context.projectId
    ? [
        ...ordered.filter((p) => p.id === context.projectId),
        ...ordered.filter((p) => p.id !== context.projectId),
      ]
    : ordered;

  const currentProject =
    projects.find((p) => p.id === context.projectId) ?? null;
  const currentWorktree =
    currentProject && context.worktreeId
      ? ((worktreesByProject.get(currentProject.id) ?? []).find(
          (w) => w.id === context.worktreeId,
        ) ?? null)
      : null;

  // The palette renders as a sibling of RouterProvider (App.tsx), where
  // useNavigate has no context and silently no-ops — same reason
  // ProjectLauncher reaches for the module-level router.
  const openWorktree = (projectId: string, worktreeId: string) => {
    close();
    void router.navigate({
      to: "/projects/$projectId/worktrees/$worktreeId",
      params: { projectId, worktreeId },
    });
  };

  // "Jump to a project" means its primary checkout. Bare repos have none,
  // and a project whose path went missing never got listed, so fall back
  // through the last-visited worktree to the new-worktree page — the same
  // chain ProjectLauncher and the add-project flow use.
  const openProject = (project: Project) => {
    const trees = worktreesByProject.get(project.id) ?? [];
    const recentId = getRecentWorktree(project.id);
    const target =
      trees.find((t) => t.isPrimary) ??
      trees.find((t) => t.id === recentId && !t.shelved) ??
      trees.find((t) => !t.shelved) ??
      trees[0];
    if (target) {
      openWorktree(project.id, target.id);
      return;
    }
    close();
    void router.navigate({
      to: "/projects/$projectId/new",
      params: { projectId: project.id },
    });
  };

  const worktreeItems: PaletteItem[] = [];
  for (const project of projectOrder) {
    const trees = worktreesByProject.get(project.id) ?? [];
    // Shelved worktrees stay reachable (finding one is half the reason to
    // shelve it) but sink below the active ones, mirroring the sidebar.
    const sorted = [
      ...trees.filter((t) => !t.shelved),
      ...trees.filter((t) => t.shelved),
    ];
    for (const worktree of sorted) {
      worktreeItems.push({
        kind: "worktree",
        value: `worktree:${project.id}:${worktree.id}`,
        terms: [worktree.branch, worktree.name, project.name],
        project,
        worktree,
        isCurrent: worktree.id === context.worktreeId,
        run: () => openWorktree(project.id, worktree.id),
      });
    }
  }

  const projectItems: PaletteItem[] = projectOrder.map((project) => ({
    kind: "project",
    value: `project:${project.id}`,
    terms: [project.name],
    project,
    worktreeCount: (worktreesByProject.get(project.id) ?? []).length,
    run: () => openProject(project),
  }));

  const actions: PaletteItem[] = [];
  const addAction = (action: {
    id: string;
    label: string;
    icon: ReactNode;
    terms?: string[];
    detail?: string;
    shortcut?: string;
    run: () => void;
  }) => {
    actions.push({
      kind: "action",
      value: `action:${action.id}`,
      terms: action.terms ?? [action.label],
      label: action.label,
      icon: action.icon,
      detail: action.detail,
      shortcut: action.shortcut,
      run: action.run,
    });
  };

  if (currentProject && currentWorktree) {
    // Launch tools for the worktree the user is standing in. ⌘1..⌘9 only
    // reach these while the detail route is mounted; the palette makes
    // them addressable by name from anywhere, including the diff view.
    for (const entry of launcher?.entries ?? []) {
      addAction({
        id: `launch:${entry.id}`,
        label: `Open in ${entry.label}`,
        icon: <LauncherIcon entry={entry} className="size-3.5" />,
        terms: [`Open in ${entry.label}`, entry.label],
        detail: currentWorktree.branch,
        run: () => {
          close();
          launch.mutate({
            projectId: currentProject.id,
            worktreeId: currentWorktree.id,
            launcherId: entry.id,
          });
        },
      });
    }

    if (currentWorktree.changedCount > 0) {
      const noun = currentWorktree.changedCount === 1 ? "file" : "files";
      addAction({
        id: "diff",
        label: "Open diff",
        icon: <FileDiff className="size-3.5" />,
        detail: `${currentWorktree.changedCount} ${noun} changed`,
        run: () => {
          close();
          void router.navigate({
            to: "/projects/$projectId/worktrees/$worktreeId/diff",
            params: {
              projectId: currentProject.id,
              worktreeId: currentWorktree.id,
            },
          });
        },
      });
    }

    // Same gate as the detail footer: the primary checkout and external
    // worktrees have nowhere to be shelved to.
    if (!currentWorktree.isPrimary && !currentWorktree.isExternal) {
      const shelved = currentWorktree.shelved;
      addAction({
        id: "shelved",
        label: shelved ? "Unshelve worktree" : "Shelve worktree",
        icon: shelved ? (
          <ArchiveRestore className="size-3.5" />
        ) : (
          <Archive className="size-3.5" />
        ),
        detail: currentWorktree.branch,
        run: () => {
          close();
          setShelved.mutate({
            projectId: currentProject.id,
            worktreeId: currentWorktree.id,
            shelved: !shelved,
          });
        },
      });
    }
  }

  if (currentProject) {
    const project = currentProject;
    addAction({
      id: "new-worktree",
      label: "New worktree…",
      icon: <GitBranchPlus className="size-3.5" />,
      terms: ["New worktree", "create worktree", project.name],
      detail: project.name,
      run: () => {
        close();
        void router.navigate({
          to: "/projects/$projectId/new",
          params: { projectId: project.id },
        });
      },
    });
    addAction({
      id: "branches",
      label: "Manage branches",
      icon: <GitBranch className="size-3.5" />,
      detail: project.name,
      run: () => {
        close();
        void router.navigate({
          to: "/projects/$projectId/branches",
          params: { projectId: project.id },
        });
      },
    });
    addAction({
      id: "configure",
      label: "Configure project",
      icon: <SlidersHorizontal className="size-3.5" />,
      detail: project.name,
      run: () => {
        close();
        void router.navigate({
          to: "/projects/$projectId/configure",
          params: { projectId: project.id },
        });
      },
    });
  }

  // openAddProject and toggleLauncher already dismiss the palette (the
  // overlays are mutually exclusive); close() first anyway so every row
  // in this list behaves the same way.
  addAction({
    id: "add-project",
    label: "Add project…",
    icon: <FolderPlus className="size-3.5" />,
    shortcut: "⌘N",
    run: () => {
      close();
      openAddProject();
    },
  });
  addAction({
    id: "launcher",
    label: "Project launcher",
    icon: <LayoutGrid className="size-3.5" />,
    shortcut: "⌘⇧P",
    run: () => {
      close();
      toggleLauncher();
    },
  });
  addAction({
    id: "settings",
    label: "Settings",
    icon: <Settings className="size-3.5" />,
    shortcut: "⌘,",
    run: () => {
      close();
      void router.navigate({ to: "/settings" });
    },
  });

  const sections: PaletteSection[] = [
    {
      id: "worktrees",
      heading: "Worktrees",
      items: rankItems(query, worktreeItems),
    },
    {
      id: "projects",
      heading: "Projects",
      items: rankItems(query, projectItems),
    },
    { id: "actions", heading: "Actions", items: rankItems(query, actions) },
  ].filter((section) => section.items.length > 0);

  return {
    sections,
    isLoading: projectsQuery.isPending,
    hasProjects: projects.length > 0,
  };
}
