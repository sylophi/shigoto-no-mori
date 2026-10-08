import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Command } from "cmdk";
import { Folder, FolderGit2, FolderSearch } from "lucide-react";
import {
  canNavigateUp,
  ensureTrailingSep,
  hasTrailingSlash,
  isAnchoredPath,
  normalizeForSubmit,
} from "@shared/projectPaths";
import { Button } from "@/components/ui/button";
import { ChipButton } from "@/components/ui/chip-button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { FileManagerIcon } from "@/components/ui/file-manager";
import {
  BrowseKeyHints,
  BrowseUpItem,
} from "@/components/shared/BrowseListParts";
import { useAddProject, useProjects } from "@/hooks/projects/useProjects";
import { fsIsGitRepoQueryOptions } from "@/hooks/fs/useFsIsGitRepo";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { notifyError } from "@/lib/toast";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import {
  ITEM_CLASS,
  keepFocusInInput,
  MODAL_COMMAND_CLASS,
} from "@/components/ui/cmdk-classes";
import { ScanningPanel } from "./ScanningPanel";
import { ResultsPanel } from "./ResultsPanel";
import { useTerrierOptIn } from "./TerrierOptIn";
import { useBrowseState } from "./useBrowseState";
import { KeyedButton } from "./DialogParts";
import { useOpenAddedProject } from "./useOpenAddedProject";
import { withToggled } from "@/lib/toggleSet";

interface AddExistingViewProps {
  // The input value IS the path. Tildified paths are expanded server-side.
  // Owned by the dialog, so it outlives a change of device.
  query: string;
  setQuery: (value: string) => void;
  addToTerrier: boolean;
  setAddToTerrier: (value: boolean) => void;
  onClose: () => void;
  // What the dialog's Escape runs instead of closing. Set while there
  // is a scan to back out of, null otherwise.
  escapeRef: RefObject<(() => void) | null>;
}

type AddExistingStage = "browse" | "scanning" | "results";

// react-doctor-disable-next-line react-doctor/no-giant-component -- browse logic already extracted to useBrowseState; remaining scan flow + keyboard handlers are tightly coupled
// react-doctor-disable-next-line react-doctor/prefer-useReducer -- fields split between browse and scan flows; transitions are linear and local, useReducer would add boilerplate without removing branching
export function AddExistingView({
  query,
  setQuery,
  addToTerrier,
  setAddToTerrier,
  onClose,
  escapeRef,
}: AddExistingViewProps) {
  const [highlighted, setHighlighted] = useState<string>("");
  const addProject = useAddProject();
  const queryClient = useQueryClient();
  const scope = useHostScope();
  const { data: existingProjects = [] } = useProjects();
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;
  const registeredPaths = new Set(existingProjects.map((p) => p.path));
  const inputRef = useRef<HTMLInputElement>(null);
  const { terrier, terrierOptIn } = useTerrierOptIn(
    addToTerrier,
    setAddToTerrier,
    inputRef,
  );

  // Scan flow state.
  const [stage, setStage] = useState<AddExistingStage>("browse");
  const [scanRoot, setScanRoot] = useState<string>("");
  const [scanResults, setScanResults] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAdding, setBulkAdding] = useState(false);
  // Which scan is current, so one cancelled mid-flight can't land its
  // results over the browse stage the user went back to.
  const scanRun = useRef(0);

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
    targetSettled,
    browseTo,
    browseUp,
  } = browse;
  // The listed folder as the device resolved it, for matching entries
  // against registered paths: the typed one may be tildified, a
  // registered one never is.
  const listedDir = listing ? ensureTrailingSep(listing.path) : null;

  const openAdded = useOpenAddedProject();

  const addAndOpen = async (path: string) => {
    try {
      const project = await addProject.mutateAsync({ path, terrier });
      onClose();
      void openAdded(project.id);
    } catch {
      // useAddProject surfaces the error via toast.
    }
  };

  const submit = async (raw?: string) => {
    const target = normalizeForSubmit(raw ?? query);
    if (target.length > 0) await addAndOpen(target);
  };

  const pickViaDialog = async () => {
    let picked: string | null;
    try {
      picked = await window.api.dialog.pickFolder();
    } catch (err) {
      // A cancelled dialog resolves to null, so this is a real failure.
      notifyError("Couldn't open the folder picker", err);
      return;
    }
    if (picked) await addAndOpen(picked);
  };

  // ---------- Scan mode ----------

  const scanCurrentDir = async () => {
    // Use the directory we're currently browsing (with trailing /).
    if (!hasTrailingSlash(browseDir)) return;
    setScanRoot(browseDir);
    setStage("scanning");
    scanRun.current += 1;
    const run = scanRun.current;
    // No try here: React Compiler bails on the early return one would
    // need.
    const results = await scope.api.fs
      .scanForGitRepos(browseDir)
      .catch((err: unknown) => {
        if (scanRun.current === run) {
          notifyError("Couldn't scan for git repos", err);
        }
        return null;
      });
    // Cancelled meanwhile: its outcome is nobody's.
    if (scanRun.current !== run) return;
    if (results === null) {
      setStage("browse");
      return;
    }
    const newOnly = results.filter((p) => !registeredPaths.has(p));
    setScanResults(newOnly);
    setSelected(new Set(newOnly));
    setHighlighted("");
    setStage("results");
  };

  const exitScan = () => {
    scanRun.current += 1;
    setStage("browse");
    setScanResults([]);
    setSelected(new Set());
    setHighlighted("");
  };

  // Escape backs out of a scan, from wherever focus sits (the panels
  // have no input to hold it). Browsing leaves the key to the dialog,
  // which closes.
  const backsOut = stage === "scanning" || stage === "results";
  useEffect(() => {
    escapeRef.current = backsOut ? exitScan : null;
    return () => {
      escapeRef.current = null;
    };
  });

  const toggleSelected = (path: string) => {
    setSelected(withToggled(path));
  };

  const bulkAdd = async () => {
    const toAdd = [...selected];
    if (toAdd.length === 0 || bulkAdding) return;
    setBulkAdding(true);
    let firstAddedId: string | null = null;
    for (const path of toAdd) {
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential to avoid races on the registry.json write
        const project = await addProject.mutateAsync({ path, terrier }); // oxlint-disable-line no-await-in-loop -- sequential to avoid races on the registry.json write
        // Plain if, not ??=: React Compiler can't lower logical assignment and
        // bails out the whole component.
        if (firstAddedId === null) firstAddedId = project.id;
      } catch {
        // Skip individual failures; user can retry by re-scanning.
      }
    }
    setBulkAdding(false);
    onClose();
    if (firstAddedId) void openAdded(firstAddedId);
  };

  // ---------- Keyboard handling ----------

  // One answer for the ← key, the `..` row and the hint. Anchored only:
  // a half-typed URL can end in a slash too (the dialog moves it to the
  // clone once it parses), and going "up" from it would eat the scheme.
  const canBrowseUp = isAnchoredPath(query) && canNavigateUp(query);

  const hasHighlighted = highlighted.startsWith("browse:");

  const primaryAction = async () => {
    // The hint can trail the input (useBrowseState), and a path pasted
    // and entered at once would scan its parent off a stale "no". ↩
    // asks for itself then.
    const isRepo = targetSettled
      ? targetIsGitRepo
      : await queryClient
          .ensureQueryData(fsIsGitRepoQueryOptions(submitTarget, scope))
          .catch(() => false);
    if (isRepo) void submit(submitTarget);
    else void scanCurrentDir();
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      void primaryAction();
      return;
    }
    if (e.key === "Enter" && !hasHighlighted) {
      e.preventDefault();
      e.stopPropagation();
      void primaryAction();
      return;
    }
    if (e.key === "ArrowLeft" && canBrowseUp && !leafFilter) {
      e.preventDefault();
      e.stopPropagation();
      browseUp();
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
        terrierOptIn={terrierOptIn}
      />
    );
  }

  // Browse stage.
  const submitLabel = targetIsGitRepo ? "Add" : "Scan for repos in folder";
  const submitKbd = hasHighlighted ? "⌘↩" : "↩";
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
      className={MODAL_COMMAND_CLASS}
    >
      <div
        data-slot="search-row"
        className="relative flex items-center gap-2 border-b border-border px-3 py-2"
      >
        <Command.Input
          ref={inputRef}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- focusing the input is the whole point of this flow
          autoFocus
          value={query}
          onValueChange={setQuery}
          onKeyDown={onInputKeyDown}
          placeholder="Folder path"
          className="min-w-0 flex-1 bg-transparent py-1 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
        />
        <KeyedButton
          icon={
            targetIsGitRepo ? (
              <FolderGit2 className="size-3.5" />
            ) : (
              <FolderSearch className="size-3.5" />
            )
          }
          label={
            addProject.isPending && targetIsGitRepo ? "Adding…" : submitLabel
          }
          keys={submitKbd}
          onMouseDown={keepFocusInInput}
          onClick={() => void primaryAction()}
          disabled={!canPrimary || addProject.isPending}
          aria-label={`${submitLabel} (${submitKbd})`}
        />
      </div>

      <Command.List
        onMouseDown={keepFocusInInput}
        className="overflow-y-auto p-2"
      >
        {canBrowseUp && <BrowseUpItem onSelect={browseUp} />}

        {filtered.map((entry) => {
          const entryPath = `${browseDir}${entry.name}`;
          const registered =
            listedDir !== null &&
            registeredPaths.has(`${listedDir}${entry.name}`);
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
              <SimpleTooltip whenTruncated lazy tip={entry.name}>
                <span className="min-w-0 flex-1 truncate font-mono">
                  {entry.name}
                </span>
              </SimpleTooltip>
              {entry.isGitRepo &&
                (registered ? (
                  <span className="text-xs text-muted-foreground/80">
                    Added
                  </span>
                ) : (
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
                    >
                      Add
                    </Button>
                  </div>
                ))}
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

      <div
        data-slot="footer-row"
        className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-xs text-muted-foreground"
      >
        <div className="flex items-center gap-3">
          <BrowseKeyHints enterFolder={hasHighlighted} goUp={canBrowseUp} />
        </div>
        <div className="flex items-center gap-3">
          {terrierOptIn}
          {/* The native dialog is this machine's, so it can't pick a
              folder on a peer's disk. */}
          {!scope.remote && (
            <ChipButton onClick={() => void pickViaDialog()}>
              <FileManagerIcon />
              Add project from Finder
            </ChipButton>
          )}
        </div>
      </div>
    </Command>
  );
}
