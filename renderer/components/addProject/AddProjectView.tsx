import { useState, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Command } from "cmdk";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CornerLeftUp,
  Folder,
  FolderGit2,
  FolderSearch,
} from "lucide-react";
import {
  canNavigateUp,
  hasTrailingSlash,
  normalizeForSubmit,
} from "@/lib/projectPaths";
import { Button } from "@/components/ui/button";
import { ChipButton } from "@/components/ui/chip-button";
import { FileManagerIcon } from "@/components/ui/file-manager";
import { useAddProject, useProjects } from "@/hooks/projects/useProjects";
import { worktreesQueryOptions } from "@/hooks/worktrees/useWorktrees";
import { notifyError } from "@/lib/toast";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { router } from "@/router";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { ITEM_CLASS } from "./cmdkClasses";
import { ScanningPanel } from "./ScanningPanel";
import { ResultsPanel } from "./ResultsPanel";
import { useBrowseState } from "./useBrowseState";

interface AddProjectViewProps {
  onClose: () => void;
}

type AddProjectStage = "browse" | "scanning" | "results";

// react-doctor-disable-next-line react-doctor/no-giant-component -- browse logic already extracted to useBrowseState; remaining scan flow + keyboard handlers are tightly coupled
// react-doctor-disable-next-line react-doctor/prefer-useReducer -- 7 fields split between browse and scan flows; transitions are linear and local, useReducer would add boilerplate without removing branching
export function AddProjectView({ onClose }: AddProjectViewProps) {
  // The input value IS the path. Tildified paths are expanded server-side.
  const [query, setQuery] = useState<string>("~/");
  const [highlighted, setHighlighted] = useState<string>("");
  const addProject = useAddProject();
  const queryClient = useQueryClient();
  const { data: existingProjects = [] } = useProjects();
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;

  // Scan flow state.
  const [stage, setStage] = useState<AddProjectStage>("browse");
  const [scanRoot, setScanRoot] = useState<string>("");
  const [scanResults, setScanResults] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAdding, setBulkAdding] = useState(false);

  // ---------- Browse mode ----------

  const browse = useBrowseState({
    query,
    setQuery,
    setHighlighted,
    enabled: stage === "browse",
  });
  const {
    browseDir,
    leafFilter,
    listing,
    isLoading,
    error,
    filtered,
    submitTarget,
    targetIsGitRepo,
    browseTo,
    browseUp,
  } = browse;

  // Land on the just-added project's primary checkout so the flow ends
  // somewhere useful instead of wherever the app happened to be.
  // ensureQueryData reuses a warm cache entry (e.g. the always-mounted
  // sidebar already listed this project mid-bulk-add) over re-listing.
  // Best-effort: if listing fails, the project is added either way. Uses
  // the module-level router because this view is rendered as a sibling of
  // RouterProvider, where `useNavigate` has no context (see ProjectLauncher).
  const selectPrimary = async (projectId: string) => {
    try {
      const worktrees = await queryClient.ensureQueryData(
        worktreesQueryOptions(projectId),
      );
      const primary = worktrees.find((w) => w.isPrimary);
      // A bare repo registers fine but has no primary checkout, so
      // offer worktree creation instead (same fallback as ProjectLauncher).
      await router.navigate(
        primary
          ? {
              to: "/projects/$projectId/worktrees/$worktreeId",
              params: { projectId, worktreeId: primary.id },
            }
          : { to: "/projects/$projectId/new", params: { projectId } },
      );
    } catch {
      // Stay wherever we are. The add itself already succeeded.
    }
  };

  const addAndOpen = async (path: string) => {
    try {
      const project = await addProject.mutateAsync(path);
      onClose();
      void selectPrimary(project.id);
    } catch {
      // useAddProject surfaces the error via toast.
    }
  };

  const submit = async (raw?: string) => {
    const target = normalizeForSubmit(raw ?? query);
    if (target.length > 0) await addAndOpen(target);
  };

  const pickViaDialog = async () => {
    const picked = await window.api.dialog.pickFolder();
    if (picked) await addAndOpen(picked);
  };

  // ---------- Scan mode ----------

  const scanCurrentDir = async () => {
    // Use the directory we're currently browsing (with trailing /).
    if (!hasTrailingSlash(browseDir)) return;
    setScanRoot(browseDir);
    setStage("scanning");
    try {
      const results = await window.api.fs.scanForGitRepos(browseDir);
      const existingPaths = new Set(existingProjects.map((p) => p.path));
      const newOnly = results.filter((p) => !existingPaths.has(p));
      setScanResults(newOnly);
      setSelected(new Set(newOnly));
      setHighlighted("");
      setStage("results");
    } catch (err) {
      notifyError("Couldn't scan for git repos", err);
      setStage("browse");
    }
  };

  const exitScan = () => {
    setStage("browse");
    setScanResults([]);
    setSelected(new Set());
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
    let firstAddedId: string | null = null;
    for (const path of toAdd) {
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential to avoid races on the registry.json write
        const project = await addProject.mutateAsync(path); // oxlint-disable-line no-await-in-loop -- sequential to avoid races on the registry.json write
        firstAddedId ??= project.id;
      } catch {
        // Skip individual failures; user can retry by re-scanning.
      }
    }
    setBulkAdding(false);
    onClose();
    if (firstAddedId) void selectPrimary(firstAddedId);
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
    if (e.key === "Enter" && e.metaKey) {
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
    if (e.key === "Enter" && e.metaKey) {
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
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- focusing the input is the whole point of this flow
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
            className={ITEM_CLASS}
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
              className={ITEM_CLASS}
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
          <div className="p-3 text-xs text-muted-foreground">Loading…</div>
        )}
        {!isLoading && !error && filtered.length === 0 && (
          <div className="p-3 text-center text-xs text-muted-foreground">
            {leafFilter.length > 0
              ? `No folders matching "${leafFilter}".`
              : "Empty directory."}
          </div>
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
        <ChipButton onClick={() => void pickViaDialog()}>
          <FileManagerIcon />
          Open in Finder
        </ChipButton>
      </div>
    </Command>
  );
}
