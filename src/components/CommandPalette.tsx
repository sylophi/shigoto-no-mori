import { useEffect, useState } from "react";
import { Command } from "cmdk";
import {
  Folder,
  GitBranch,
  Moon,
  Plus,
  Sun,
  SunMoon,
  TreeDeciduous,
} from "lucide-react";
import { useAddProjectFlow, useProjects } from "@/hooks/useProjects";
import { useSelection } from "@/hooks/useSelection";
import { useTheme } from "@/hooks/useTheme";
import { useAllProjectWorktrees } from "@/hooks/useWorktrees";
import type { Worktree } from "@shared/schemas";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const { data: projects = [] } = useProjects();
  const { selectWorktree, beginNewWorktree } = useSelection();
  const { setTheme } = useTheme();
  const addProject = useAddProjectFlow();

  // Toggle on ⌘K / Ctrl+K.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Worktree queries are gated on `open` so we don't refresh them in the
  // background while the palette isn't visible.
  const worktreeQueries = useAllProjectWorktrees(projects, open);

  const allWorktrees = projects.flatMap((project, i) => {
    const trees = (worktreeQueries[i]?.data ?? []) as Worktree[];
    return trees.map((tree) => ({ project, tree }));
  });

  const handle = (action: () => void | Promise<void>) => () => {
    setOpen(false);
    void action();
  };

  if (!open) return null;

  return (
    <div
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/10 p-4 pt-[12vh] backdrop-blur-sm"
    >
      <Command
        label="Command palette"
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl ring-1 ring-foreground/10"
        loop
      >
        <Command.Input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- focusing the input is the whole point of a command palette
          autoFocus
          placeholder="Search worktrees, switch project, run a command…"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        <Command.List className="max-h-80 overflow-y-auto px-1 py-2">
          <Command.Empty className="px-4 py-6 text-center text-sm text-muted-foreground">
            Nothing here.
          </Command.Empty>

          {allWorktrees.length > 0 && (
            <Command.Group
              heading="Worktrees"
              className="px-2 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
            >
              {allWorktrees.map(({ project, tree }) => (
                <Command.Item
                  key={tree.id}
                  value={`${tree.branch} ${project.name} ${tree.path}`}
                  onSelect={handle(() => selectWorktree(tree.id))}
                  className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
                >
                  <GitBranch className="size-3.5 text-muted-foreground" />
                  <span className="truncate font-mono">{tree.branch}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {project.name}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <Command.Group
            heading="Projects"
            className="px-2 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
          >
            {projects.map((project) => (
              <Command.Item
                key={`new-${project.id}`}
                value={`new worktree ${project.name}`}
                onSelect={handle(() => beginNewWorktree(project.id))}
                className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
              >
                <Plus className="size-3.5 text-muted-foreground" />
                <span>
                  New worktree in{" "}
                  <span className="text-foreground">{project.name}</span>
                </span>
              </Command.Item>
            ))}
            <Command.Item
              value="add project"
              onSelect={handle(() => {
                void addProject.start();
              })}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
            >
              <Folder className="size-3.5 text-muted-foreground" />
              <span>Add project…</span>
            </Command.Item>
          </Command.Group>

          <Command.Group
            heading="Theme"
            className="px-2 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
          >
            <Command.Item
              value="theme light"
              onSelect={handle(() => setTheme("light"))}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
            >
              <Sun className="size-3.5 text-muted-foreground" />
              Light
            </Command.Item>
            <Command.Item
              value="theme dark"
              onSelect={handle(() => setTheme("dark"))}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
            >
              <Moon className="size-3.5 text-muted-foreground" />
              Dark
            </Command.Item>
            <Command.Item
              value="theme system"
              onSelect={handle(() => setTheme("system"))}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
            >
              <SunMoon className="size-3.5 text-muted-foreground" />
              System
            </Command.Item>
          </Command.Group>

          {projects.length === 0 && allWorktrees.length === 0 && (
            <Command.Group
              heading="Get started"
              className="px-2 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
            >
              <Command.Item
                value="welcome"
                disabled
                className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground"
              >
                <TreeDeciduous className="size-3.5" />
                Add your first project to begin.
              </Command.Item>
            </Command.Group>
          )}
        </Command.List>
      </Command>
    </div>
  );
}
