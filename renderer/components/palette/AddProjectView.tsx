import { useState, type KeyboardEvent } from "react";
import { Command } from "cmdk";
import finderIconUrl from "@/app-icons/finder.png";
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
import { useAddProject, useProjects } from "@/hooks/projects/useProjects";
import { notifyError } from "@/lib/toast";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
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

  const submit = async (raw?: string) => {
    const target = normalizeForSubmit(raw ?? query);
    if (target.length === 0) return;
    try {
      await addProject.mutateAsync(target);
      onClose();
    } catch {
      // useAddProject surfaces the error via toast.
    }
  };

  const pickViaDialog = async () => {
    const picked = await window.api.dialog.pickFolder();
    if (!picked) return;
    try {
      await addProject.mutateAsync(picked);
      onClose();
    } catch {
      // useAddProject surfaces the error via toast.
    }
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
    for (const path of toAdd) {
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential to avoid races on the state.json write
        await addProject.mutateAsync(path); // oxlint-disable-line no-await-in-loop -- sequential to avoid races on the state.json write
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
