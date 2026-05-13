import { useEffect, useState, type KeyboardEvent } from "react";
import { Command } from "cmdk";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CornerLeftUp,
  Folder,
  FolderPlus,
  GitBranch,
  Moon,
  Plus,
  Sun,
  SunMoon,
  TreeDeciduous,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  appendBrowsePathSegment,
  canNavigateUp,
  getBrowseDirectoryPath,
  getBrowseLeafSegment,
  getBrowseParentPath,
  hasTrailingSlash,
  normalizeForSubmit,
} from "@/lib/projectPaths";
import { useAddProject, useProjects } from "@/hooks/useProjects";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { useFsListDirectory } from "@/hooks/useFsListDirectory";
import { useSelection } from "@/hooks/useSelection";
import { useTheme } from "@/hooks/useTheme";
import { useAllProjectWorktrees } from "@/hooks/useWorktrees";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import type { Worktree } from "@shared/schemas";

export function CommandPalette() {
  const { open, mode, setOpen, toggle, openIn } = useCommandPalette();

  // Toggle on ⌘K / Ctrl+K.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/40 p-4 pt-[10vh] backdrop-blur-sm"
    >
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/5">
        {mode === "browse" ? (
          <BrowseView onAddProject={() => openIn("add-project")} />
        ) : (
          <AddProjectView
            onDone={() => setOpen(false)}
            onBack={() => openIn("browse")}
          />
        )}
      </div>
    </div>
  );
}

// ---------- Browse (existing palette) ----------

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
    <Command label="Command palette" loop>
      <Command.Input
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- focusing the input is the whole point of a command palette
        autoFocus
        placeholder="Search worktrees, switch project, run a command…"
        className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Command.List className="max-h-96 overflow-y-auto p-2">
        <Command.Empty className="px-4 py-6 text-center text-sm text-muted-foreground">
          Nothing here.
        </Command.Empty>

        {allWorktrees.length > 0 && (
          <Command.Group
            heading="Worktrees"
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase"
          >
            {allWorktrees.map(({ project, tree }) => (
              <Command.Item
                key={tree.id}
                value={`${tree.branch} ${project.name} ${tree.path}`}
                onSelect={handle(() => selectWorktree(tree.id))}
                className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
              >
                <GitBranch className="size-4 text-muted-foreground/80" />
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
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase"
        >
          {projects.map((project) => (
            <Command.Item
              key={`new-${project.id}`}
              value={`new worktree ${project.name}`}
              onSelect={handle(() => beginNewWorktree(project.id))}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
            >
              <Plus className="size-4 text-muted-foreground/80" />
              <span>
                New worktree in{" "}
                <span className="text-foreground">{project.name}</span>
              </span>
            </Command.Item>
          ))}
          <Command.Item
            value="add project local folder browse"
            onSelect={() => onAddProject()}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
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

        <Command.Group
          heading="Theme"
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase"
        >
          <Command.Item
            value="theme light"
            onSelect={handle(() => setTheme("light"))}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
          >
            <Sun className="size-4 text-muted-foreground/80" />
            Light
          </Command.Item>
          <Command.Item
            value="theme dark"
            onSelect={handle(() => setTheme("dark"))}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
          >
            <Moon className="size-4 text-muted-foreground/80" />
            Dark
          </Command.Item>
          <Command.Item
            value="theme system"
            onSelect={handle(() => setTheme("system"))}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
          >
            <SunMoon className="size-4 text-muted-foreground/80" />
            System
          </Command.Item>
        </Command.Group>

        {projects.length === 0 && allWorktrees.length === 0 && (
          <Command.Group
            heading="Get started"
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase"
          >
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

// ---------- Add Project (T3-style path-as-input browser) ----------

interface AddProjectViewProps {
  onDone: () => void;
  onBack: () => void;
}

function AddProjectView({ onDone, onBack }: AddProjectViewProps) {
  // The input value IS the path. Tildified paths are expanded server-side.
  const [query, setQuery] = useState<string>("~/");
  const [highlighted, setHighlighted] = useState<string>("");
  const addProject = useAddProject();

  // The directory we're browsing (everything up to and including the last "/").
  // When the user types after a "/", the leaf is the filter.
  const browseDir = getBrowseDirectoryPath(query);
  const leafFilter = hasTrailingSlash(query) ? "" : getBrowseLeafSegment(query);

  const listingEnabled = browseDir.length > 0 && hasTrailingSlash(browseDir);
  const {
    data: listing,
    isLoading,
    error,
  } = useFsListDirectory(browseDir, listingEnabled);

  const filtered = (listing?.entries ?? []).filter((e) =>
    e.name.toLowerCase().startsWith(leafFilter.toLowerCase()),
  );

  const browseTo = (name: string) => {
    setQuery(appendBrowsePathSegment(query, name));
    setHighlighted("");
  };

  const browseUp = () => {
    const parent = getBrowseParentPath(query);
    if (parent) {
      setQuery(parent);
      setHighlighted("");
    }
  };

  const submit = async (raw?: string) => {
    const target = normalizeForSubmit(raw ?? query);
    if (target.length === 0) return;
    try {
      await addProject.mutateAsync(target);
      onDone();
    } catch {
      // Error rendered inline below.
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

  const hasHighlighted = highlighted.startsWith("browse:");

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // ⌘↩ always submits the typed path, regardless of selection.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      void submit();
      return;
    }
    // Plain Enter with no entry highlighted submits the path.
    if (e.key === "Enter" && !hasHighlighted) {
      e.preventDefault();
      e.stopPropagation();
      void submit();
      return;
    }
    // Plain Enter with an entry highlighted: let cmdk activate it (descend).
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onBack();
      return;
    }
    if (e.key === "Backspace" && query === "") {
      e.preventDefault();
      onBack();
    }
  };

  const submitLabel = "Add";
  const submitKbd = hasHighlighted ? "⌘↩" : "↩";
  const canBrowseUp = canNavigateUp(query);

  return (
    <Command
      label="Add project"
      loop
      shouldFilter={false}
      value={highlighted}
      onValueChange={setHighlighted}
    >
      <div className="relative flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </button>
        <FolderPlus className="size-4 shrink-0 text-muted-foreground/80" />
        <Command.Input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- focusing the input is the whole point of a command palette
          autoFocus
          value={query}
          onValueChange={setQuery}
          onKeyDown={onInputKeyDown}
          placeholder="Enter project path (e.g. ~/projects/my-app)"
          className="min-w-0 flex-1 bg-transparent py-1 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
        />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void submit()}
          disabled={query.trim().length === 0 || addProject.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`${submitLabel} (${submitKbd})`}
          title={`${submitLabel} (${submitKbd})`}
        >
          <span>{addProject.isPending ? "Adding…" : submitLabel}</span>
          <KbdGroup className="pointer-events-none">
            <Kbd>{submitKbd}</Kbd>
          </KbdGroup>
        </button>
      </div>

      <Command.List className="max-h-96 overflow-y-auto p-2">
        {canBrowseUp && (
          <Command.Item
            value="browse:up"
            keywords={[".."]}
            onSelect={browseUp}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
          >
            <CornerLeftUp className="size-4 text-muted-foreground/80" />
            <span className="font-mono text-muted-foreground">..</span>
          </Command.Item>
        )}

        {filtered.map((entry) => (
          <Command.Item
            key={entry.name}
            value={`browse:${browseDir}${entry.name}`}
            keywords={[entry.name]}
            onSelect={() => browseTo(entry.name)}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
          >
            <Folder
              className={cn(
                "size-4",
                entry.isGitRepo
                  ? "text-foreground"
                  : "text-muted-foreground/80",
              )}
            />
            <span className="truncate font-mono">{entry.name}</span>
            {entry.isGitRepo && (
              <span className="rounded-sm border border-border bg-muted px-1 font-mono text-[10px] tracking-wide text-muted-foreground">
                git
              </span>
            )}
          </Command.Item>
        ))}

        {isLoading && !listing && (
          <div className="px-3 py-3 text-xs text-muted-foreground">
            Loading…
          </div>
        )}
        {error && (
          <div className="px-3 py-3 text-xs text-destructive">
            {error.message}
          </div>
        )}
        {!isLoading && !error && filtered.length === 0 && !canBrowseUp && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            {leafFilter.length > 0
              ? `No folders matching "${leafFilter}".`
              : "Type a path to start browsing."}
          </div>
        )}
        {!isLoading && !error && filtered.length === 0 && canBrowseUp && (
          <div className="px-3 py-3 text-center text-xs text-muted-foreground">
            {leafFilter.length > 0
              ? `No folders matching "${leafFilter}". Press ⌘↩ to add anyway.`
              : "Empty directory."}
          </div>
        )}
      </Command.List>

      {addProject.error && (
        <div className="border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {addProject.error.message}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <KbdGroup>
            <Kbd>
              <ArrowUp />
            </Kbd>
            <Kbd>
              <ArrowDown />
            </Kbd>
            <span className="text-muted-foreground/80">Navigate</span>
          </KbdGroup>
          {hasHighlighted && (
            <KbdGroup>
              <Kbd>↩</Kbd>
              <span className="text-muted-foreground/80">Select</span>
            </KbdGroup>
          )}
          <KbdGroup>
            <Kbd>Esc</Kbd>
            <span className="text-muted-foreground/80">Back</span>
          </KbdGroup>
        </div>
        <button
          type="button"
          onClick={() => void pickViaDialog()}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
        >
          Open in Finder
        </button>
      </div>
    </Command>
  );
}
