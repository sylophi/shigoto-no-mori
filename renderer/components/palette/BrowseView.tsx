import { useState } from "react";
import { Command } from "cmdk";
import {
  FolderPlus,
  GitBranch,
  Plus,
  Settings as SettingsIcon,
  TreeDeciduous,
} from "lucide-react";
import { router } from "@/router";
import { useCommandPalette } from "@/hooks/ui/useCommandPalette";
import { useProjects } from "@/hooks/projects/useProjects";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import type { Worktree } from "@shared/schemas";
import { GROUP_HEADING_CLASS, ITEM_CLASS } from "./cmdkClasses";

// Shown at the tail of a capped group to hint that typing reveals the rest.
function MoreHint({ count }: { count: number }) {
  return (
    <div className="px-2 py-1.5 text-xs text-muted-foreground/70">
      +{count} more, type to search
    </div>
  );
}

interface BrowseViewProps {
  onAddProject: () => void;
}

export function BrowseView({ onAddProject }: BrowseViewProps) {
  const { setOpen } = useCommandPalette();
  const { data: projects = [] } = useProjects();
  const [search, setSearch] = useState("");

  const worktreeQueries = useAllProjectWorktrees(projects, true);
  const allWorktrees = projects.flatMap((project, i) => {
    const trees = (worktreeQueries[i]?.data ?? []) as Worktree[];
    return trees.map((tree) => ({ project, tree }));
  });

  // Cap each group when there's no query so the palette doesn't dump the
  // entire forest on you. Typing expands to the full set (cmdk filters).
  const LIST_CAP = 3;
  const isFiltering = search.trim().length > 0;
  const visibleWorktrees = isFiltering
    ? allWorktrees
    : allWorktrees.slice(0, LIST_CAP);
  const visibleProjects = isFiltering ? projects : projects.slice(0, LIST_CAP);
  const hiddenWorktreeCount = allWorktrees.length - visibleWorktrees.length;
  const hiddenProjectCount = projects.length - visibleProjects.length;

  // CommandPalette is rendered as a sibling of RouterProvider in App.tsx, so
  // `useNavigate` here has no router context and silently no-ops. Use the
  // module-level router instance directly instead.
  const navigate = router.navigate.bind(router);

  const handle = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <Command label="Command palette" loop>
      <Command.Input
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- focusing the input is the whole point of a command palette
        autoFocus
        value={search}
        onValueChange={setSearch}
        placeholder="Search worktrees, switch project, run a command…"
        className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Command.List className="max-h-96 overflow-y-auto p-2">
        <Command.Empty className="px-4 py-6 text-center text-sm text-muted-foreground">
          Nothing here.
        </Command.Empty>

        {visibleWorktrees.length > 0 && (
          <Command.Group heading="Worktrees" className={GROUP_HEADING_CLASS}>
            {visibleWorktrees.map(({ project, tree }) => (
              <Command.Item
                key={tree.id}
                value={`${tree.name} ${tree.branch} ${project.name} ${tree.path}`}
                onSelect={handle(
                  () =>
                    void navigate({
                      to: "/projects/$projectId/worktrees/$worktreeId",
                      params: {
                        projectId: project.id,
                        worktreeId: tree.id,
                      },
                    }),
                )}
                className={ITEM_CLASS}
              >
                <GitBranch className="size-4 text-muted-foreground/80" />
                <span className="truncate font-mono">{tree.branch}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {tree.name}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {project.name}
                </span>
              </Command.Item>
            ))}
            {hiddenWorktreeCount > 0 && (
              <MoreHint count={hiddenWorktreeCount} />
            )}
          </Command.Group>
        )}

        <Command.Group heading="Projects" className={GROUP_HEADING_CLASS}>
          {visibleProjects.map((project) => (
            <Command.Item
              key={`new-${project.id}`}
              value={`new worktree ${project.name}`}
              onSelect={handle(
                () =>
                  void navigate({
                    to: "/projects/$projectId/new",
                    params: { projectId: project.id },
                  }),
              )}
              className={ITEM_CLASS}
            >
              <Plus className="size-4 text-muted-foreground/80" />
              <span>
                New worktree in{" "}
                <span className="text-foreground">{project.name}</span>
              </span>
            </Command.Item>
          ))}
          {hiddenProjectCount > 0 && <MoreHint count={hiddenProjectCount} />}
          <Command.Item
            value="add project local folder browse"
            onSelect={() => onAddProject()}
            className={ITEM_CLASS}
          >
            <FolderPlus className="size-4 text-muted-foreground/80" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm text-foreground">Add project…</span>
              <span className="truncate text-xs text-muted-foreground/70">
                Browse a folder on disk
              </span>
            </span>
          </Command.Item>
        </Command.Group>

        <Command.Group heading="Navigate" className={GROUP_HEADING_CLASS}>
          <Command.Item
            value="settings preferences appearance theme"
            onSelect={handle(() => void navigate({ to: "/settings" }))}
            className={ITEM_CLASS}
          >
            <SettingsIcon className="size-4 text-muted-foreground/80" />
            Settings
          </Command.Item>
        </Command.Group>

        {projects.length === 0 && allWorktrees.length === 0 && (
          <Command.Group heading="Get started" className={GROUP_HEADING_CLASS}>
            <Command.Item
              value="welcome"
              disabled
              className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground"
            >
              <TreeDeciduous className="size-4" />
              Add your first project to begin.
            </Command.Item>
          </Command.Group>
        )}
      </Command.List>
    </Command>
  );
}
