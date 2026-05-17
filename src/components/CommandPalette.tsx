import { useEffect, useState, type KeyboardEvent } from "react";
import { Command } from "cmdk";
import finderIconUrl from "@/assets/app-icons/finder.png";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  CornerLeftUp,
  Folder,
  FolderGit2,
  FolderPlus,
  FolderSearch,
  GitBranch,
  Loader2,
  Plus,
  Settings as SettingsIcon,
  Square,
  TreeDeciduous,
} from "lucide-react";
import {
  appendBrowsePathSegment,
  canNavigateUp,
  getBrowseDirectoryPath,
  getBrowseLeafSegment,
  getBrowseParentPath,
  hasTrailingSlash,
  normalizeForSubmit,
} from "@/lib/projectPaths";
import { Button } from "@/components/ui/button";
import { PathSpan } from "@/components/ui/path-span";
import { router } from "@/router";
import { useAddProject, useProjects } from "@/hooks/useProjects";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { useFsIsGitRepo } from "@/hooks/useFsIsGitRepo";
import { useFsListDirectory } from "@/hooks/useFsListDirectory";
import { useRuntimeInfo } from "@/hooks/useRuntimeInfo";
import { useAllProjectWorktrees } from "@/hooks/useWorktrees";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import type { Worktree } from "@shared/schemas";

export function CommandPalette() {
  const { open, mode, setOpen, toggle, openIn } = useCommandPalette();

  // Both shortcuts are wired via native menu accelerators in src/main/menu.ts
  // — View → Command palette (⌘⇧P, also ⌘P) and File → Add project… (⌘N).
  useEffect(() => window.api.palette.onToggle(toggle), [toggle]);
  useEffect(
    () => window.api.palette.onAddProject(() => openIn("add-project")),
    [openIn],
  );

  if (!open) return null;

  return (
    <div
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
      onKeyDown={(e) => {
        // AddProjectView owns its own Escape handling (cancels scan stage,
        // or closes from the browse stage); only close the palette on
        // Escape from browse mode here.
        if (e.key === "Escape" && mode === "browse") {
          e.preventDefault();
          setOpen(false);
        }
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/40 p-4 pt-[10vh] backdrop-blur-[2px]"
    >
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/5">
        {mode === "browse" ? (
          <BrowseView onAddProject={() => openIn("add-project")} />
        ) : (
          <AddProjectView onClose={() => setOpen(false)} />
        )}
      </div>
    </div>
  );
}

// ---------- Browse (existing palette) ----------

function BrowseView({ onAddProject }: { onAddProject: () => void }) {
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
          <Command.Group
            heading="Worktrees"
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase"
          >
            {visibleWorktrees.map(({ project, tree }) => (
              <Command.Item
                key={tree.id}
                value={`${tree.name} ${tree.branch} ${project.name} ${tree.path}`}
                onSelect={handle(
                  () =>
                    void navigate({
                      to: "/projects/$projectId/worktrees/$worktreeName",
                      params: {
                        projectId: project.id,
                        worktreeName: tree.name,
                      },
                    }),
                )}
                className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
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
              <div className="px-2 py-1.5 text-xs text-muted-foreground/70">
                +{hiddenWorktreeCount} more, type to search
              </div>
            )}
          </Command.Group>
        )}

        <Command.Group
          heading="Projects"
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase"
        >
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
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
            >
              <Plus className="size-4 text-muted-foreground/80" />
              <span>
                New worktree in{" "}
                <span className="text-foreground">{project.name}</span>
              </span>
            </Command.Item>
          ))}
          {hiddenProjectCount > 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground/70">
              +{hiddenProjectCount} more, type to search
            </div>
          )}
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
          heading="Navigate"
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase"
        >
          <Command.Item
            value="settings preferences appearance theme"
            onSelect={handle(() => void navigate({ to: "/settings" }))}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
          >
            <SettingsIcon className="size-4 text-muted-foreground/80" />
            Settings
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
  onClose: () => void;
}

type AddProjectStage = "browse" | "scanning" | "results";

function AddProjectView({ onClose }: AddProjectViewProps) {
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

  // What the user is about to submit. When the query points at an
  // existing git repo we offer "Add"; otherwise we offer "Scan for git
  // repos" so the same primary slot doubles as the discovery path.
  const submitTarget = normalizeForSubmit(query);
  const { data: targetIsGitRepo = false } = useFsIsGitRepo(
    submitTarget,
    stage === "browse",
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
      onClose();
    } catch {
      // Error rendered inline below.
    }
  };

  const pickViaDialog = async () => {
    const picked = await window.api.dialog.pickFolder();
    if (!picked) return;
    try {
      await addProject.mutateAsync(picked);
      onClose();
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
    onClose();
  };

  // ---------- Keyboard handling ----------

  const hasHighlighted = highlighted.startsWith("browse:");

  const primaryAction = () => {
    if (targetIsGitRepo) {
      void submit();
    } else {
      void scanCurrentDir();
    }
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      primaryAction();
      return;
    }
    if (e.key === "Enter" && !hasHighlighted) {
      e.preventDefault();
      e.stopPropagation();
      primaryAction();
      return;
    }
    if (e.key === "ArrowLeft" && canNavigateUp(query) && !leafFilter) {
      e.preventDefault();
      e.stopPropagation();
      browseUp();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Backspace" && query === "") {
      e.preventDefault();
      onClose();
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
      <ScanningPanel scanRoot={scanRoot} home={home} onCancel={exitScan} />
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
  const submitLabel = targetIsGitRepo ? "Add" : "Scan for repos in folder";
  const submitKbd = hasHighlighted ? "⌘↩" : "↩";
  const canBrowseUp = canNavigateUp(query);
  const canPrimary = targetIsGitRepo
    ? submitTarget.length > 0
    : hasTrailingSlash(browseDir) && !!listing && !error;

  return (
    <Command
      label="Add project"
      loop
      shouldFilter={false}
      value={highlighted}
      onValueChange={setHighlighted}
    >
      <div className="relative flex items-center gap-2 border-b border-border px-3 py-2">
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
          onClick={primaryAction}
          disabled={!canPrimary || addProject.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`${submitLabel} (${submitKbd})`}
          title={`${submitLabel} (${submitKbd})`}
        >
          {targetIsGitRepo ? (
            <FolderGit2 className="size-3.5" />
          ) : (
            <FolderSearch className="size-3.5" />
          )}
          <span>
            {addProject.isPending && targetIsGitRepo ? "Adding…" : submitLabel}
          </span>
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

        {filtered.map((entry) => {
          const entryPath = `${browseDir}${entry.name}`;
          return (
            <Command.Item
              key={entry.name}
              value={`browse:${entryPath}`}
              keywords={[entry.name]}
              onSelect={() => browseTo(entry.name)}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
            >
              {entry.isGitRepo ? (
                <FolderGit2 className="size-4 text-foreground" />
              ) : (
                <Folder className="size-4 text-muted-foreground/80" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono">
                {entry.name}
              </span>
              {entry.isGitRepo && (
                <div
                  className="inline-flex items-center"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  role="presentation"
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => void submit(entryPath)}
                    title={`Add ${entry.name} as a project`}
                  >
                    Add
                  </Button>
                </div>
              )}
            </Command.Item>
          );
        })}

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
              <span className="text-muted-foreground/80">Enter folder</span>
            </KbdGroup>
          )}
          {canBrowseUp && (
            <KbdGroup>
              <Kbd>
                <ArrowLeft />
              </Kbd>
              <span className="text-muted-foreground/80">Go up</span>
            </KbdGroup>
          )}
        </div>
        <button
          type="button"
          onClick={() => void pickViaDialog()}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground/80 ring-1 ring-border transition-colors ring-inset hover:bg-accent hover:text-foreground"
        >
          <img src={finderIconUrl} alt="" className="size-4" />
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
}: {
  scanRoot: string;
  home: string | null;
  onCancel: () => void;
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
        <PathSpan
          path={scanRoot}
          home={home}
          className="min-w-0 flex-1 truncate font-mono text-sm"
        />
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
            <span className="flex font-mono text-xs text-muted-foreground/70">
              <span className="shrink-0">in&nbsp;</span>
              <PathSpan
                path={props.scanRoot}
                home={props.home}
                className="min-w-0 flex-1 truncate"
              />
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
            props.results.map((path) => (
              <ResultRow
                key={path}
                path={path}
                scanRoot={props.scanRoot}
                home={props.home}
                isSelected={props.selected.has(path)}
                onToggle={() => props.onToggle(path)}
              />
            ))
          )}
        </Command.List>

        <div className="flex items-center justify-end gap-3 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
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

function ResultRow({
  path,
  scanRoot,
  home,
  isSelected,
  onToggle,
}: {
  path: string;
  scanRoot: string;
  home: string | null;
  isSelected: boolean;
  onToggle: () => void;
}) {
  const relative = relativeFromRoot(path, scanRoot);
  // Result == scanRoot leaves `relative` equal to the absolute path; let
  // PathSpan tildify+shorten it. Nested results are already short.
  const showAbsolute = relative === path;
  return (
    <Command.Item
      value={`result:${path}`}
      keywords={[relative]}
      onSelect={onToggle}
      className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
    >
      {isSelected ? (
        <Check className="size-4 text-foreground" />
      ) : (
        <Square className="size-4 text-muted-foreground/60" />
      )}
      <FolderGit2 className="size-4 text-muted-foreground/80" />
      {showAbsolute ? (
        <PathSpan
          path={path}
          home={home}
          className="min-w-0 flex-1 truncate font-mono"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono" title={path}>
          {relative}
        </span>
      )}
    </Command.Item>
  );
}
