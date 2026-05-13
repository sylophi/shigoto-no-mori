import { useEffect, useState } from "react";
import { Command } from "cmdk";
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Moon,
  Plus,
  Sun,
  SunMoon,
  TreeDeciduous,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAddProject, useProjects } from "@/hooks/useProjects";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { useFsListDirectory } from "@/hooks/useFsListDirectory";
import { useRuntimeInfo } from "@/hooks/useRuntimeInfo";
import { useSelection } from "@/hooks/useSelection";
import { useTheme } from "@/hooks/useTheme";
import { useAllProjectWorktrees } from "@/hooks/useWorktrees";
import type { Worktree } from "@shared/schemas";

export function CommandPalette() {
  const { open, mode, setOpen, toggle, openIn } = useCommandPalette();

  // Toggle on ⌘K / Ctrl+K.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

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
        // Disable cmdk's auto-filtering in browse-fs mode; we supply the list.
        shouldFilter={mode === "browse"}
      >
        {mode === "browse" ? (
          <BrowseView onAddProject={() => openIn("add-project")} />
        ) : (
          <AddProjectView
            onDone={() => setOpen(false)}
            onBack={() => openIn("browse")}
          />
        )}
      </Command>
    </div>
  );
}

function BrowseView({ onAddProject }: { onAddProject: () => void }) {
  const { setOpen } = useCommandPalette();
  const { data: projects = [] } = useProjects();
  const { selectWorktree, beginNewWorktree } = useSelection();
  const { setTheme } = useTheme();

  const worktreeQueries = useAllProjectWorktrees(projects, true);
  const allWorktrees = projects.flatMap((project, i) => {
    const trees = (worktreeQueries[i]?.data ?? []) as Worktree[];
    return trees.map((tree) => ({ project, tree }));
  });

  const handle = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <>
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
            onSelect={() => onAddProject()}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
          >
            <FolderPlus className="size-3.5 text-muted-foreground" />
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
    </>
  );
}

interface AddProjectViewProps {
  onDone: () => void;
  onBack: () => void;
}

function AddProjectView({ onDone, onBack }: AddProjectViewProps) {
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;
  const [cwd, setCwd] = useState<string>(() => home ?? "~");
  const [filter, setFilter] = useState("");
  const addProject = useAddProject();
  // Defer the listing fetch until we know the real home dir.
  const {
    data: listing,
    isLoading,
    error,
  } = useFsListDirectory(cwd, cwd !== "~");

  // Once we know the real home dir from runtime info, hop into it.
  useEffect(() => {
    if (home && cwd === "~") setCwd(home);
  }, [home, cwd]);

  const matching = (listing?.entries ?? []).filter((entry) =>
    entry.name.toLowerCase().includes(filter.toLowerCase()),
  );

  const descend = (name: string) => {
    setCwd((prev) => joinPath(prev, name));
    setFilter("");
  };

  const goUp = () => {
    const parent = parentOf(listing?.path ?? cwd);
    if (parent) {
      setCwd(parent);
      setFilter("");
    }
  };

  const submit = async () => {
    const target = listing?.path ?? cwd;
    try {
      await addProject.mutateAsync(target);
      onDone();
    } catch {
      // Error is on addProject.error; banner renders below.
    }
  };

  const pickViaDialog = async () => {
    const picked = await window.api.dialog.pickFolder();
    if (!picked) return;
    try {
      await addProject.mutateAsync(picked);
      onDone();
    } catch {
      // Error rendered inline.
    }
  };

  // ⌘↩ adds the current folder regardless of selection.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Backspace" && filter === "") {
      e.preventDefault();
      goUp();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onBack();
    }
  };

  const displayPath = listing?.path
    ? tildifyForDisplay(listing.path, home)
    : cwd;

  return (
    <div role="group" aria-label="Add project" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Back"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Add project
        </span>
        <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
          {displayPath}
        </span>
      </div>
      <Command.Input
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- focusing the input is the whole point of a command palette
        autoFocus
        value={filter}
        onValueChange={setFilter}
        placeholder="Type to filter, ↩ to descend, ⌘↩ to add this folder"
        className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Command.List className="max-h-80 overflow-y-auto px-1 py-2">
        <Command.Item
          value="__add_here__"
          onSelect={() => void submit()}
          className="mb-1 flex cursor-default items-center gap-2 rounded-md border border-dashed border-border px-2 py-1.5 text-sm aria-selected:border-solid aria-selected:bg-accent aria-selected:text-accent-foreground"
        >
          <FolderOpen className="size-3.5 text-muted-foreground" />
          <span>
            Add <span className="font-mono">{displayPath}</span> as project
          </span>
          <span className="ml-auto text-[10px] tracking-wide text-muted-foreground">
            ⌘↩
          </span>
        </Command.Item>

        {parentOf(listing?.path ?? cwd) && (
          <Command.Item
            value="__parent__"
            onSelect={goUp}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
          >
            <ArrowLeft className="size-3.5 text-muted-foreground" />
            <span className="font-mono">..</span>
          </Command.Item>
        )}

        {isLoading && (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            Loading…
          </div>
        )}
        {error && (
          <div className="px-3 py-2 text-xs text-destructive">
            {error.message}
          </div>
        )}

        {matching.map((entry) => (
          <Command.Item
            key={entry.name}
            value={entry.name}
            onSelect={() => descend(entry.name)}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
          >
            <Folder
              className={cn(
                "size-3.5",
                entry.isGitRepo ? "text-foreground" : "text-muted-foreground",
              )}
            />
            <span className="truncate font-mono">{entry.name}</span>
            {entry.isGitRepo && (
              <span className="ml-1 rounded border border-border bg-card px-1 py-0 text-[9px] tracking-wide text-muted-foreground">
                git
              </span>
            )}
            <ChevronRight className="ml-auto size-3 text-muted-foreground" />
          </Command.Item>
        ))}

        {!isLoading && !error && matching.length === 0 && (
          <Command.Empty className="px-4 py-6 text-center text-sm text-muted-foreground">
            No matching folders.
          </Command.Empty>
        )}
      </Command.List>

      {addProject.error && (
        <div className="border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {addProject.error.message}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-3">
          <Hint k="↩" label="descend" />
          <Hint k="⌘↩" label="add" />
          <Hint k="⌫" label="up" />
          <Hint k="esc" label="back" />
        </div>
        <button
          type="button"
          onClick={() => void pickViaDialog()}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-accent hover:text-foreground"
        >
          <FolderOpen className="size-3" />
          Open in Finder
        </button>
      </div>
    </div>
  );
}

function Hint({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="rounded border border-border bg-card px-1 py-0 font-mono text-[10px]">
        {k}
      </kbd>
      <span>{label}</span>
    </span>
  );
}

function joinPath(base: string, child: string): string {
  if (base.endsWith("/")) return `${base}${child}`;
  return `${base}/${child}`;
}

function parentOf(path: string): string | null {
  if (!path || path === "/") return null;
  const trimmed = path.replace(/\/$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

function tildifyForDisplay(absolute: string, home: string | null): string {
  if (!home) return absolute;
  if (absolute === home) return "~";
  if (absolute.startsWith(`${home}/`)) return `~${absolute.slice(home.length)}`;
  return absolute;
}
