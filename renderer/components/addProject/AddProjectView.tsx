import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
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
  GitBranch,
} from "lucide-react";
import { repoNameFromUrl, stripUrlCredentials } from "@shared/cloneUrl";
import { normalizeRemoteUrl } from "@shared/git/repoIdentity.mts";
import {
  canNavigateUp,
  ensureTrailingSep,
  hasTrailingSlash,
  isAnchoredPath,
  normalizeForSubmit,
  tildify,
} from "@/lib/projectPaths";
import { Button } from "@/components/ui/button";
import { ChipButton } from "@/components/ui/chip-button";
import { FileManagerIcon } from "@/components/ui/file-manager";
import { FolderPickerModal } from "@/components/shared/FolderPickerModal";
import {
  useAddProject,
  useCloneProject,
  useProjects,
} from "@/hooks/projects/useProjects";
import { fsIsGitRepoQueryOptions } from "@/hooks/fs/useFsIsGitRepo";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { worktreesQueryOptions } from "@/hooks/worktrees/useWorktrees";
import type { Worktree } from "@shared/schemas";
import { notifyError, toast } from "@/lib/toast";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useProjectNav } from "@/hooks/projects/useProjectNav";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { ITEM_CLASS, keepFocusInInput } from "@/components/ui/cmdk-classes";
import { CloneDestination, CloningPanel } from "./ClonePanel";
import { defaultCloneParent } from "./cloneDestination";
import { ScanningPanel } from "./ScanningPanel";
import { ResultsPanel } from "./ResultsPanel";
import { useBrowseState } from "./useBrowseState";
import { withToggled } from "@/lib/toggleSet";

interface AddProjectViewProps {
  // The input value IS the path. Tildified paths are expanded server-side.
  // Or it is a remote URL, and the flow clones instead of browsing.
  // Owned by the dialog, so it outlives a change of device.
  query: string;
  setQuery: (value: string) => void;
  onClose: () => void;
  // What the dialog's Escape runs instead of closing. Set while there
  // is a scan to back out of, null otherwise.
  escapeRef: RefObject<(() => void) | null>;
}

type AddProjectStage = "browse" | "scanning" | "results" | "cloning";

// react-doctor-disable-next-line react-doctor/no-giant-component -- browse logic already extracted to useBrowseState; remaining scan flow + keyboard handlers are tightly coupled
// react-doctor-disable-next-line react-doctor/prefer-useReducer -- 7 fields split between browse and scan flows; transitions are linear and local, useReducer would add boilerplate without removing branching
export function AddProjectView({
  query,
  setQuery,
  onClose,
  escapeRef,
}: AddProjectViewProps) {
  const [highlighted, setHighlighted] = useState<string>("");
  const addProject = useAddProject();
  const queryClient = useQueryClient();
  const scope = useHostScope();
  const { data: existingProjects = [] } = useProjects();
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;
  const registeredPaths = new Set(existingProjects.map((p) => p.path));

  // ---------- Clone mode ----------

  // Derived from the input rather than entered: a URL typed by hand
  // parses as a remote long before it is finished, and a mode that
  // flipped on a keystroke would take the half-typed URL with it.
  const cloneName = repoNameFromUrl(query);
  const cloneProject = useCloneProject();
  // The picked parent folder. Null follows the device's own layout.
  const [pickedCloneParent, setPickedCloneParent] = useState<string | null>(
    null,
  );
  const [cloneParentPickerOpen, setCloneParentPickerOpen] = useState(false);
  // The picker takes focus while it is up. Handing it back puts the
  // next ↩ where this flow listens, so the pick and the clone are two
  // keys with no click between them.
  const inputRef = useRef<HTMLInputElement>(null);
  const closeCloneParentPicker = () => {
    setCloneParentPickerOpen(false);
    inputRef.current?.focus();
  };
  const cloneParent =
    pickedCloneParent ?? defaultCloneParent(existingProjects, home);
  // Everything the clone is, or null while the input is a path: one
  // fact, so no branch below has to agree with another about it.
  const clone =
    cloneName === null
      ? null
      : {
          name: cloneName,
          // A peer clones with its own credentials. Ones pasted in with
          // the URL stay on this device, the rule pickCloneUrl keeps.
          url: scope.remote ? stripUrlCredentials(query) : query.trim(),
          // The remote as repo identity spells it (host/owner/repo).
          repo: normalizeRemoteUrl(query) ?? query.trim(),
          // Tildified here, once: a picked parent comes back as the
          // device resolved it, absolute.
          dest: tildify(`${cloneParent}${cloneName}`, home),
        };
  // Undefined on this device: only a peer's name is worth saying. The
  // hook's own fallback covers a peer that leaves the registry mid-clone,
  // so the wording never slides back to this device's.
  const peerLabel = useRemoteDeviceLabel(scope.deviceId);
  const deviceLabel = scope.remote ? peerLabel : undefined;
  // A clone outlives the dialog, so what follows it has to know
  // whether anyone is still looking.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Scan flow state.
  const [stage, setStage] = useState<AddProjectStage>("browse");
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
    // A URL is not a path to list on the device's disk.
    enabled: stage === "browse" && clone === null,
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

  // Land on the just-added project's primary checkout so the flow ends
  // somewhere useful instead of wherever the app happened to be.
  // ensureQueryData reuses a warm cache entry (e.g. the always-mounted
  // sidebar already listed this project mid-bulk-add) over re-listing.
  // Best-effort: if listing fails, the project is added either way.
  // Both navs follow the scope, so a project added on a peer opens
  // under that peer's /devices twin.
  // Route choice made outside the try below: React Compiler can't
  // lower a conditional inside one, and bails out the whole component.
  const worktreeNav = useWorktreeNav();
  const projectNav = useProjectNav();
  const selectPrimary = async (projectId: string) => {
    try {
      const worktrees = await queryClient.ensureQueryData(
        worktreesQueryOptions(projectId, scope),
      );
      openProject(worktreeNav, projectNav, projectId, worktrees);
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

  const cloneAndOpen = async () => {
    if (clone === null) return;
    setStage("cloning");
    // useCloneProject surfaces the error via toast. No try here: React
    // Compiler bails on the early return one would need.
    const project = await cloneProject
      .mutateAsync({ url: clone.url, parentDir: cloneParent, name: clone.name })
      .catch(() => null);
    if (project === null) {
      // Back to the URL, still in the input, to fix it or the folder.
      setStage("browse");
      return;
    }
    // Closed meanwhile: say it landed, and leave the user where they are.
    if (!mounted.current) {
      toast.success(
        deviceLabel
          ? `Cloned ${project.name} on ${deviceLabel}`
          : `Cloned ${project.name}`,
      );
      return;
    }
    onClose();
    void selectPrimary(project.id);
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
    // No try here, for cloneAndOpen's reason: the early return.
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
  // have no input to hold it). Every other stage leaves the key to the
  // dialog, which closes: a clone keeps running without it.
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
        const project = await addProject.mutateAsync(path); // oxlint-disable-line no-await-in-loop -- sequential to avoid races on the registry.json write
        // Plain if, not ??=: React Compiler can't lower logical assignment and
        // bails out the whole component.
        if (firstAddedId === null) firstAddedId = project.id;
      } catch {
        // Skip individual failures; user can retry by re-scanning.
      }
    }
    setBulkAdding(false);
    onClose();
    if (firstAddedId) void selectPrimary(firstAddedId);
  };

  // ---------- Keyboard handling ----------

  // One answer for the ← key, the `..` row and the hint. Anchored only:
  // a half-typed URL can end in a slash too, and going "up" from it
  // would eat the scheme.
  const canBrowseUp = isAnchoredPath(query) && canNavigateUp(query);

  // Never in clone mode: the rows are gone, but cmdk can keep the value
  // of one that unmounted with the rest, and ↩ has to mean "clone".
  const hasHighlighted = clone === null && highlighted.startsWith("browse:");

  const primaryAction = async () => {
    if (clone !== null) {
      void cloneAndOpen();
      return;
    }
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
      />
    );
  }

  if (stage === "cloning" && clone !== null) {
    return (
      <CloningPanel
        repo={clone.repo}
        dest={clone.dest}
        deviceLabel={deviceLabel}
      />
    );
  }

  // Browse stage.
  const cloneMode = clone !== null;
  const submitLabel = cloneMode
    ? "Clone"
    : targetIsGitRepo
      ? "Add"
      : "Scan for repos in folder";
  const submitKbd = hasHighlighted ? "⌘↩" : "↩";
  const canPrimary =
    cloneMode ||
    (targetIsGitRepo
      ? submitTarget.length > 0
      : hasTrailingSlash(browseDir) && !!listing && !error);

  return (
    <>
      <Command
        label="Add project"
        loop
        shouldFilter={false}
        value={highlighted}
        onValueChange={setHighlighted}
      >
        <div className="relative flex items-center gap-2 border-b border-border px-3 py-2">
          <Command.Input
            ref={inputRef}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- focusing the input is the whole point of this flow
            autoFocus
            value={query}
            onValueChange={setQuery}
            onKeyDown={onInputKeyDown}
            placeholder="Folder path, or a git URL to clone"
            className="min-w-0 flex-1 bg-transparent py-1 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onMouseDown={keepFocusInInput}
            onClick={() => void primaryAction()}
            disabled={!canPrimary || addProject.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={`${submitLabel} (${submitKbd})`}
            title={`${submitLabel} (${submitKbd})`}
          >
            {cloneMode ? (
              <GitBranch className="size-3.5" />
            ) : targetIsGitRepo ? (
              <FolderGit2 className="size-3.5" />
            ) : (
              <FolderSearch className="size-3.5" />
            )}
            <span>
              {addProject.isPending && targetIsGitRepo
                ? "Adding…"
                : submitLabel}
            </span>
            <KbdGroup className="pointer-events-none">
              <Kbd>{submitKbd}</Kbd>
            </KbdGroup>
          </button>
        </div>

        {clone !== null && (
          <CloneDestination
            repo={clone.repo}
            dest={clone.dest}
            deviceLabel={deviceLabel}
            onChangeParent={() => setCloneParentPickerOpen(true)}
          />
        )}
        {/* Kept mounted (cmdk wants its list), just empty, in clone mode. */}
        <Command.List
          onMouseDown={keepFocusInInput}
          className={cloneMode ? "hidden" : "max-h-96 overflow-y-auto p-2"}
        >
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
                <span className="min-w-0 flex-1 truncate font-mono">
                  {entry.name}
                </span>
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
                        title={`Add ${entry.name} as a project`}
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

        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            {cloneMode ? (
              <KbdGroup>
                <Kbd>↩</Kbd>
                <span className="text-muted-foreground/80">Clone</span>
              </KbdGroup>
            ) : (
              <KbdGroup>
                <Kbd>
                  <ArrowUp />
                </Kbd>
                <Kbd>
                  <ArrowDown />
                </Kbd>
                <span className="text-muted-foreground/80">Navigate</span>
              </KbdGroup>
            )}
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
          {/* The native dialog is this machine's, so it can't pick a
            folder on a peer's disk. */}
          {!scope.remote && !cloneMode && (
            <ChipButton onClick={() => void pickViaDialog()}>
              <FileManagerIcon />
              Add project from Finder
            </ChipButton>
          )}
        </div>
      </Command>
      {/* Outside the Command: a portal still bubbles through the React
          tree, and the picker's arrow keys are not this list's. */}
      {cloneParentPickerOpen && (
        <FolderPickerModal
          initialPath={cloneParent}
          title="Clone into"
          hint={`${clone?.name ?? "The repository"} becomes a new folder inside the one you pick.`}
          onPick={(parent) => {
            setPickedCloneParent(ensureTrailingSep(parent));
            closeCloneParentPicker();
          }}
          onClose={closeCloneParentPicker}
        />
      )}
    </>
  );
}

function openProject(
  worktreeNav: ReturnType<typeof useWorktreeNav>,
  projectNav: ReturnType<typeof useProjectNav>,
  projectId: string,
  worktrees: readonly Worktree[],
) {
  // A bare repo registers fine but has no primary checkout, so offer
  // worktree creation instead (same fallback as ProjectLauncher).
  const primary = worktrees.find((w) => w.isPrimary);
  if (primary) worktreeNav.toWorktree(projectId, primary.id);
  else projectNav.toProjectPage("new", projectId);
}
