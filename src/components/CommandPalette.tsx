import { useEffect, useState, type KeyboardEvent } from "react";
import { Command } from "cmdk";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  CornerLeftUp,
  Folder,
  FolderPlus,
  FolderSearch,
  GitBranch,
  Loader2,
  Moon,
  Plus,
  Square,
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
import { useRuntimeInfo } from "@/hooks/useRuntimeInfo";
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/60 p-4 pt-[10vh] backdrop-blur-sm"
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

type AddProjectStage = "browse" | "scanning" | "results";

function AddProjectView({ onDone, onBack }: AddProjectViewProps) {
  // The input value IS the path. Tildified paths are expanded server-side.
  const [query, setQuery] = useState<string>("~/");
  const [highlighted, setHighlighted] = useState<string>("");
  const addProject = useAddProject();
  const { data: existingProjects = [] } = useProjects();
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;

  // Scan flow state.
  const [stage, setStage] = useState<AddProjectStage>("browse");
  const [scanRoot, setScanRoot] = useState<string>("");
  const [scanResults, setScanResults] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanError, setScanError] = useState<Error | null>(null);
  const [bulkAdding, setBulkAdding] = useState(false);

  // ---------- Browse mode ----------

  const browseDir = getBrowseDirectoryPath(query);
  const leafFilter = hasTrailingSlash(query) ? "" : getBrowseLeafSegment(query);

  const listingEnabled =
    stage === "browse" && browseDir.length > 0 && hasTrailingSlash(browseDir);
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

  // ---------- Scan mode ----------

  const scanCurrentDir = async () => {
    // Use the directory we're currently browsing (with trailing /).
    if (!hasTrailingSlash(browseDir)) return;
    setScanRoot(browseDir);
    setStage("scanning");
    setScanError(null);
    try {
      const results = await window.api.fs.scanForGitRepos(browseDir);
      const existingPaths = new Set(existingProjects.map((p) => p.path));
      const newOnly = results.filter((p) => !existingPaths.has(p));
      setScanResults(newOnly);
      setSelected(new Set(newOnly));
      setHighlighted("");
      setStage("results");
    } catch (e) {
      setScanError(e instanceof Error ? e : new Error(String(e)));
      setStage("browse");
    }
  };

  const exitScan = () => {
    setStage("browse");
    setScanResults([]);
    setSelected(new Set());
    setScanError(null);
    setHighlighted("");
  };

  const toggleSelected = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const bulkAdd = async () => {
    const toAdd = [...selected];
    if (toAdd.length === 0 || bulkAdding) return;
    setBulkAdding(true);
    for (const path of toAdd) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential to avoid races on the state.json write
        await addProject.mutateAsync(path);
      } catch {
        // Skip individual failures; user can retry by re-scanning.
      }
    }
    setBulkAdding(false);
    onDone();
  };

  // ---------- Keyboard handling ----------

  const hasHighlighted = highlighted.startsWith("browse:");

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      void submit();
      return;
    }
    if (e.key === "Enter" && !hasHighlighted) {
      e.preventDefault();
      e.stopPropagation();
      void submit();
      return;
    }
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

  const onResultsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      void bulkAdd();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      exitScan();
    }
  };

  // ---------- Render ----------

  if (stage === "scanning") {
    return (
      <ScanningPanel
        scanRoot={scanRoot}
        home={home}
        onCancel={exitScan}
        onBack={onBack}
      />
    );
  }

  if (stage === "results") {
    return (
      <ResultsPanel
        scanRoot={scanRoot}
        home={home}
        results={scanResults}
        selected={selected}
        highlighted={highlighted}
        onHighlightChange={setHighlighted}
        onToggle={toggleSelected}
        onSelectAll={() => setSelected(new Set(scanResults))}
        onSelectNone={() => setSelected(new Set())}
        onBack={exitScan}
        onAdd={bulkAdd}
        bulkAdding={bulkAdding}
        onKeyDown={onResultsKeyDown}
      />
    );
  }

  // Browse stage.
  const submitLabel = "Add";
  const submitKbd = hasHighlighted ? "⌘↩" : "↩";
  const canBrowseUp = canNavigateUp(query);
  const canScan = hasTrailingSlash(browseDir) && !!listing && !error;

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
        {canScan && (
          <Command.Item
            value="action:scan"
            keywords={["scan", "discover", "find"]}
            onSelect={() => void scanCurrentDir()}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
          >
            <FolderSearch className="size-4 text-muted-foreground/80" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-foreground">
                Scan this folder for git repos
              </span>
              <span className="truncate text-xs text-muted-foreground/70">
                Recursively, stopping at the outermost .git
              </span>
            </span>
          </Command.Item>
        )}

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
        {!isLoading && !error && filtered.length === 0 && (
          <div className="px-3 py-3 text-center text-xs text-muted-foreground">
            {leafFilter.length > 0
              ? `No folders matching "${leafFilter}".`
              : "Empty directory."}
          </div>
        )}
      </Command.List>

      {(addProject.error || scanError) && (
        <div className="border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {addProject.error?.message ?? scanError?.message}
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

// ---------- Scanning panel ----------

function ScanningPanel({
  scanRoot,
  home,
  onCancel,
  onBack: _onBack,
}: {
  scanRoot: string;
  home: string | null;
  onCancel: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </button>
        <FolderSearch className="size-4 shrink-0 text-muted-foreground/80" />
        <span className="min-w-0 flex-1 truncate font-mono text-sm">
          {tildify(scanRoot, home)}
        </span>
      </div>
      <div className="flex flex-col items-center gap-3 px-4 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin text-muted-foreground/60" />
        <span>Looking for git repos…</span>
      </div>
      <div className="flex items-center justify-end border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        <KbdGroup>
          <Kbd>Esc</Kbd>
          <span className="text-muted-foreground/80">Cancel</span>
        </KbdGroup>
      </div>
    </div>
  );
}

// ---------- Scan results panel ----------

interface ResultsPanelProps {
  scanRoot: string;
  home: string | null;
  results: string[];
  selected: Set<string>;
  highlighted: string;
  onHighlightChange: (v: string) => void;
  onToggle: (path: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onBack: () => void;
  onAdd: () => Promise<void>;
  bulkAdding: boolean;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}

function ResultsPanel(props: ResultsPanelProps) {
  const allSelected =
    props.results.length > 0 && props.selected.size === props.results.length;
  const tildifiedRoot = tildify(props.scanRoot, props.home);

  return (
    <div onKeyDown={props.onKeyDown} role="group" aria-label="Scan results">
      <Command
        label="Scan results"
        loop
        shouldFilter={false}
        value={props.highlighted}
        onValueChange={props.onHighlightChange}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <button
            type="button"
            onClick={props.onBack}
            aria-label="Back"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </button>
          <FolderSearch className="size-4 shrink-0 text-muted-foreground/80" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm text-foreground">
              {props.results.length === 0
                ? "No new git repos found"
                : `${props.results.length} new git repo${props.results.length === 1 ? "" : "s"}`}
            </span>
            <span className="truncate font-mono text-xs text-muted-foreground/70">
              in {tildifiedRoot}
            </span>
          </div>
          {props.results.length > 0 && (
            <button
              type="button"
              onClick={allSelected ? props.onSelectNone : props.onSelectAll}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          )}
        </div>

        <Command.List className="max-h-96 overflow-y-auto p-2">
          {props.results.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">
              All git repos in this folder are already added.
            </div>
          ) : (
            props.results.map((path) => {
              const isSelected = props.selected.has(path);
              const relative = relativeFromRoot(path, props.scanRoot);
              return (
                <Command.Item
                  key={path}
                  value={`result:${path}`}
                  keywords={[relative]}
                  onSelect={() => props.onToggle(path)}
                  className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
                >
                  {isSelected ? (
                    <Check className="size-4 text-foreground" />
                  ) : (
                    <Square className="size-4 text-muted-foreground/60" />
                  )}
                  <Folder className="size-4 text-muted-foreground/80" />
                  <span className="truncate font-mono">{relative}</span>
                </Command.Item>
              );
            })
          )}
        </Command.List>

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
            <KbdGroup>
              <Kbd>↩</Kbd>
              <span className="text-muted-foreground/80">Toggle</span>
            </KbdGroup>
            <KbdGroup>
              <Kbd>Esc</Kbd>
              <span className="text-muted-foreground/80">Back</span>
            </KbdGroup>
          </div>
          <button
            type="button"
            onClick={() => void props.onAdd()}
            disabled={props.selected.size === 0 || props.bulkAdding}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span>
              {props.bulkAdding
                ? "Adding…"
                : `Add ${props.selected.size} project${props.selected.size === 1 ? "" : "s"}`}
            </span>
            <KbdGroup className="pointer-events-none">
              <Kbd>⌘↩</Kbd>
            </KbdGroup>
          </button>
        </div>
      </Command>
    </div>
  );
}

function relativeFromRoot(absolute: string, root: string): string {
  const trimmedRoot = root.endsWith("/") ? root : `${root}/`;
  return absolute.startsWith(trimmedRoot)
    ? absolute.slice(trimmedRoot.length)
    : absolute;
}

function tildify(path: string, home: string | null): string {
  if (!home || !path) return path;
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}
