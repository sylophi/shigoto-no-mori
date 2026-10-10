import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  canNavigateUp,
  ensureTrailingSep,
  hasTrailingSlash,
  isAnchoredPath,
  normalizeForSubmit,
} from "@shigomori/contracts/projectPaths";
import { useAddProject, useProjects } from "@/hooks/projects/useProjects";
import { fsIsGitRepoQueryOptions } from "@/hooks/fs/useFsIsGitRepo";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { notifyError } from "@/lib/toast";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { ScanningPanelView } from "./ScanningPanelView";
import { ResultsPanelView } from "./ResultsPanelView";
import { useTerrierOptIn } from "./TerrierOptIn";
import { useBrowseState } from "./useBrowseState";
import { useOpenAddedProject } from "./useOpenAddedProject";
import { withToggled } from "@/lib/toggleSet";
import { AddExistingFormView } from "./AddExistingFormView";

interface AddExistingFormProps {
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
export function AddExistingForm({
  query,
  setQuery,
  addToTerrier,
  setAddToTerrier,
  onClose,
  escapeRef,
}: AddExistingFormProps) {
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
      .scanForGitRepos({ path: browseDir })
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
      <ScanningPanelView scanRoot={scanRoot} home={home} onCancel={exitScan} />
    );
  }

  if (stage === "results") {
    return (
      <ResultsPanelView
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

  return (
    <AddExistingFormView
      query={query}
      onQuery={setQuery}
      inputRef={inputRef}
      onInputKeyDown={onInputKeyDown}
      highlighted={highlighted}
      onHighlight={setHighlighted}
      browseDir={browseDir}
      entries={filtered}
      registeredNames={
        new Set(
          listedDir === null
            ? []
            : filtered
                .filter((entry) =>
                  registeredPaths.has(`${listedDir}${entry.name}`),
                )
                .map((entry) => entry.name),
        )
      }
      isLoading={isLoading}
      hasListing={!!listing}
      error={error}
      leafFilter={leafFilter}
      targetIsGitRepo={targetIsGitRepo}
      canPrimary={
        targetIsGitRepo
          ? submitTarget.length > 0
          : hasTrailingSlash(browseDir) && !!listing && !error
      }
      pending={addProject.isPending}
      onPrimary={() => void primaryAction()}
      canBrowseUp={canBrowseUp}
      onBrowseUp={browseUp}
      onBrowseTo={browseTo}
      onAdd={(path) => void submit(path)}
      terrierOptIn={terrierOptIn}
      // The native dialog is this machine's, so it can't pick a folder
      // on a peer's disk.
      onPickFolder={scope.remote ? null : () => void pickViaDialog()}
    />
  );
}
