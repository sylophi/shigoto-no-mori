import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useParams } from "@tanstack/react-router";
import { Command } from "cmdk";
import { ArrowDown, ArrowUp, FileDiff, Folder, Play } from "lucide-react";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { ModalShell } from "@/components/ui/modal-shell";
import { ITEM_CLASS, keepFocusInInput } from "@/components/ui/cmdk-classes";
import { BranchLabel } from "@/components/ui/branch-label";
import { LauncherIcon } from "@/components/shared/LauncherIcon";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { WorktreeKindIcon } from "@/components/shared/WorktreeKindIcon";
import { DeviceBadge, useDeviceBadges } from "@/components/sidebar/DeviceBadge";
import { StatusIndicator } from "@/components/sidebar/StatusIndicator";
import { MirrorBadge } from "@/components/sidebar/WorktreeRow";
import { worktreeRowKey } from "@/components/sidebar/buildSidebarRows";
import { rowDeviceId } from "@/lib/routePaths";
import {
  useLaunch,
  useLauncherForProject,
} from "@/hooks/launchers/useLaunchers";
import { useProjects } from "@/hooks/projects/useProjects";
import { MaybeHostScope } from "@/hooks/remote/useHostScope";
import { useMirrorLinks } from "@/hooks/remote/useMirrors";
import { useRemoteDeviceApi } from "@/hooks/remote/useRemoteDevices";
import { useRemoteForests } from "@/hooks/remote/useRemoteForests";
import { usePackageScripts } from "@/hooks/scripts/usePackageScripts";
import { useSortedPackageScripts } from "@/hooks/scripts/usePackageScriptSort";
import { useScriptRunner } from "@/hooks/scripts/useScriptRunner";
import { useHiddenWorktreePrefixes } from "@/hooks/sharedSettings/useHiddenWorktreePrefixes";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import { isEditableTarget, isOverlayOpen } from "@/lib/dom";
import { rankByScore } from "@/lib/fuzzyMatch";
import { hasLocalHost } from "@/lib/localHost";
import { readWorktreeVisits, recordWorktreeVisit } from "@/lib/recentWorktrees";
import { cn } from "@/lib/utils";
import { slotToParam, type ScriptSlot } from "@/store/scriptSlot";
import {
  buildPaletteEntries,
  initialPaletteKey,
  rankPaletteEntries,
  type PaletteEntry,
} from "./buildPaletteEntries";

// ⌘K: every worktree on every machine, one fuzzy list. ↩ jumps to the
// highlighted one, ⌘↩ opens its changes, and ⇥ (or → at the end of the
// query) steps into what else it offers: its launch tools and its
// package scripts. The project launcher (`, ⌘⇧P) picks a project; this
// picks the worktree itself, so a peer's is one keystroke away like a
// local one and drawn the same, its device a badge on the row.
export function WorktreePalette() {
  const { paletteOpen: open, setPaletteOpen: setOpen } = useOverlays();
  // The worktree page on screen, if any, on this machine or a peer's:
  // any of its pages (detail, changes, a commit, a console) counts as
  // a visit, and the palette opens past it.
  const { deviceId, worktreeId } = useParams({ strict: false }) as {
    deviceId?: string;
    worktreeId?: string;
  };
  const pageKey =
    worktreeId === undefined || deviceId === undefined
      ? undefined
      : worktreeRowKey(rowDeviceId(deviceId), worktreeId);

  useEffect(() => {
    if (pageKey !== undefined) recordWorktreeVisit(pageKey);
  }, [pageKey]);

  // Where focus was when the palette opened, handed back when it
  // closes. Captured in the keydown, before the input's autoFocus
  // takes it.
  const returnFocus = useRef<Element | null>(null);
  useEffect(() => {
    if (open) return;
    const previous = returnFocus.current;
    returnFocus.current = null;
    if (previous instanceof HTMLElement) previous.focus();
  }, [open]);

  // On window, like the launcher's backtick, so it works wherever focus
  // sits. ⌘K fires from text fields too. Ctrl+K doesn't: in a text
  // field it is kill-line (macOS's text system, and the running
  // program's in the console's terminal), so there it only closes the
  // palette. Opening waits for any other overlay to close, and closing
  // is the palette's own toggle.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || e.repeat || e.isComposing) return;
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (!open && !e.metaKey && isEditableTarget(e.target)) return;
      if (!open && isOverlayOpen()) return;
      e.preventDefault();
      if (!open) returnFocus.current = document.activeElement;
      setOpen(!open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;
  return <PaletteDialog pageKey={pageKey} onClose={() => setOpen(false)} />;
}

type GoTo = (
  entry: PaletteEntry,
  page: "detail" | "diff" | "script",
  extra?: { scriptKey?: string },
) => void;

function PaletteDialog({
  pageKey,
  onClose,
}: {
  pageKey: string | undefined;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  // The worktree whose actions are showing, or null on the list.
  const [picked, setPicked] = useState<PaletteEntry | null>(null);
  // Read once per open: a visit recorded while the palette is up can't
  // happen, and re-reading storage every render would.
  const [visits] = useState(readWorktreeVisits);
  const { toPageOn } = useWorktreeNav();

  // The sidebar's own reads, so they are warm. The sidebar's observers
  // and push invalidation keep the worktree lists fresh, so opening
  // doesn't re-list every project's worktrees in git.
  const { data: projects = [] } = useProjects();
  const worktreeQueries = useAllProjectWorktrees(projects, true, {
    refetchOnMount: false,
  });
  const { items: remote } = useRemoteForests();
  const mirrors = useMirrorLinks();
  const deviceBadges = useDeviceBadges();
  const hiddenPrefixes = useHiddenWorktreePrefixes();
  const { entries, entryKeyOf } = buildPaletteEntries({
    projects,
    worktreeQueries,
    remote,
    mirrors,
    deviceBadges,
    hiddenPrefixes,
    visits,
  });
  const shown = rankPaletteEntries(query.trim(), entries);
  // Seeded once, from the order the palette opened on (the sidebar's
  // reads are warm, so it is already filled). cmdk takes over from
  // there, moving to the top match as the query changes.
  const [highlighted, setHighlighted] = useState(() =>
    initialPaletteKey(shown, pageKey && entryKeyOf(pageKey)),
  );
  const current = shown.find((entry) => entry.key === highlighted) ?? shown[0];

  // A worktree page on whichever machine the entry lives on.
  const go: GoTo = (entry, page, extra = {}) => {
    onClose();
    toPageOn(entry.device?.deviceId, page, {
      projectId: entry.worktree.projectId,
      worktreeId: entry.worktree.id,
      ...extra,
    });
  };

  const pick = (entry: PaletteEntry) => {
    setPicked(entry);
    setQuery("");
    setHighlighted("");
  };

  // Back on the list, the worktree the actions were for is highlighted
  // again (the Command remounts per stage, see below).
  const back = () => {
    setPicked(null);
    setQuery("");
    setHighlighted(picked?.key ?? "");
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (picked) {
      if (e.key === "Backspace" && query === "") {
        e.preventDefault();
        back();
      } else if (e.key === "Tab") {
        // Already in the actions. The shell doesn't trap focus, so a
        // second Tab would leave for the page underneath.
        e.preventDefault();
      }
      return;
    }
    if (!current) return;
    const atEnd = e.currentTarget.selectionStart === query.length;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      go(current, "diff");
    } else if (e.key === "Tab" || (e.key === "ArrowRight" && atEnd)) {
      e.preventDefault();
      pick(current);
    }
  };

  // Escape backs out one stage: the actions to the list, a query to
  // empty, then the palette itself.
  const onEscape = () => {
    if (picked) back();
    else if (query) setQuery("");
    else onClose();
  };

  return (
    <ModalShell onClose={onClose} onEscape={onEscape}>
      {/* Keyed by stage: a query cleared in place makes cmdk jump to its
          first row, which would undo the highlight back() restores. A
          fresh mount keeps the highlight it is handed. */}
      <Command
        key={picked ? "actions" : "worktrees"}
        label="Worktrees"
        loop
        shouldFilter={false}
        value={highlighted}
        onValueChange={setHighlighted}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          {picked && (
            <button
              type="button"
              onClick={back}
              onMouseDown={keepFocusInInput}
              title="Back to worktrees (⌫)"
              className="flex max-w-[50%] shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs"
            >
              <ProjectIcon
                projectId={picked.worktree.projectId}
                deviceId={picked.device?.deviceId}
                className="size-3"
                fallback={Folder}
              />
              <span className="truncate font-mono">
                <BranchLabel
                  branch={picked.worktree.branch}
                  detached={picked.worktree.detached}
                />
              </span>
              {picked.device && <DeviceBadge badge={picked.device} />}
            </button>
          )}
          <Command.Input
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the palette just opened
            autoFocus
            value={query}
            onValueChange={setQuery}
            onKeyDown={onInputKeyDown}
            placeholder={picked ? "Search actions…" : "Search worktrees…"}
            className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <Command.List
          onMouseDown={keepFocusInInput}
          className="max-h-96 overflow-y-auto p-2"
        >
          {picked ? (
            <ActionList
              entry={picked}
              query={query.trim()}
              go={go}
              onClose={onClose}
            />
          ) : (
            shown.map((entry) => (
              <Command.Item
                key={entry.key}
                value={entry.key}
                onSelect={() => go(entry, "detail")}
                className={ITEM_CLASS}
              >
                <EntryRow entry={entry} />
              </Command.Item>
            ))
          )}
          <Command.Empty className="p-3 text-center text-xs text-muted-foreground">
            {picked
              ? "No actions match."
              : entries.length === 0
                ? "No worktrees yet."
                : "No worktrees match."}
          </Command.Empty>
        </Command.List>

        <div className="flex items-center gap-3 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
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
            <span className="text-muted-foreground/80">
              {picked ? "Run" : "Open"}
            </span>
          </KbdGroup>
          {picked ? (
            <KbdGroup>
              <Kbd>⌫</Kbd>
              <span className="text-muted-foreground/80">Back</span>
            </KbdGroup>
          ) : (
            <>
              <KbdGroup>
                <Kbd>⌘↩</Kbd>
                <span className="text-muted-foreground/80">Changes</span>
              </KbdGroup>
              <KbdGroup>
                <Kbd>⇥</Kbd>
                <span className="text-muted-foreground/80">Actions</span>
              </KbdGroup>
            </>
          )}
        </div>
      </Command>
    </ModalShell>
  );
}

// The sidebar's reading of a worktree on one line: project and folder
// beside the branch, the tree row's trailing marks, and the device
// badge a peer's row wears (or the mirror badge a local pair wears).
function EntryRow({ entry }: { entry: PaletteEntry }) {
  const { worktree, project, device, mirror } = entry;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2",
        device && !device.reachable && "opacity-60",
      )}
    >
      <ProjectIcon
        projectId={worktree.projectId}
        deviceId={device?.deviceId}
        fallback={Folder}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-xs">
          <BranchLabel branch={worktree.branch} detached={worktree.detached} />
        </span>
        <span className="truncate text-3xs text-muted-foreground">
          {project.name} · {worktree.name}
        </span>
      </div>
      <StatusIndicator worktree={worktree} />
      <WorktreeKindIcon worktree={worktree} showTooltip={false} />
      {device && <DeviceBadge badge={device} />}
      {mirror && <MirrorBadge mirror={mirror} />}
    </div>
  );
}

// The picked worktree's second step. Its scripts run on the machine it
// lives on, so the list mounts in that device's scope: a peer asleep
// has no session to run anything over, and offers the pages alone.
function ActionList({
  entry,
  query,
  go,
  onClose,
}: {
  entry: PaletteEntry;
  query: string;
  go: GoTo;
  onClose: () => void;
}) {
  const deviceId = entry.device?.deviceId;
  const api = useRemoteDeviceApi(deviceId);
  const reachable = deviceId === undefined || api !== undefined;
  // The worktree list's fuzzy match, each group ranked on its own so
  // the groups keep their places.
  const pages = rankByScore(query, PAGE_ACTIONS, (action) => action.label);
  return (
    <>
      {pages.length > 0 && (
        <Command.Group heading="Go to" className={GROUP_CLASS}>
          {pages.map(({ page, label, Icon }) => (
            <Command.Item
              key={page}
              value={page}
              onSelect={() => go(entry, page)}
              className={ITEM_CLASS}
            >
              <Icon className="size-4 text-muted-foreground/80" />
              {label}
            </Command.Item>
          ))}
        </Command.Group>
      )}
      {/* Launch tools open on the machine showing this window, so only a
          worktree here has any (LaunchSection's rule). */}
      {deviceId === undefined && hasLocalHost && (
        <LauncherItems entry={entry} query={query} onClose={onClose} />
      )}
      {reachable && (
        <MaybeHostScope deviceId={deviceId ?? ""} api={api}>
          <ScriptItems entry={entry} query={query} go={go} />
        </MaybeHostScope>
      )}
    </>
  );
}

const PAGE_ACTIONS = [
  { page: "detail", label: "Open worktree", Icon: Folder },
  { page: "diff", label: "Open changes", Icon: FileDiff },
] as const;

const GROUP_CLASS =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground";

function LauncherItems({
  entry,
  query,
  onClose,
}: {
  entry: PaletteEntry;
  query: string;
  onClose: () => void;
}) {
  const { data } = useLauncherForProject(entry.worktree.projectId);
  const launch = useLaunch();
  const launchers = rankByScore(
    query,
    data?.entries ?? [],
    (launcher) => `Open in ${launcher.label}`,
  );
  if (launchers.length === 0) return null;
  return (
    <Command.Group heading="Launch" className={GROUP_CLASS}>
      {launchers.map((launcher) => (
        <Command.Item
          key={launcher.id}
          value={`launch:${launcher.id}`}
          onSelect={() => {
            onClose();
            launch.mutate({
              projectId: entry.worktree.projectId,
              worktreeId: entry.worktree.id,
              launcherId: launcher.id,
            });
          }}
          className={ITEM_CLASS}
        >
          <LauncherIcon entry={launcher} />
          Open in {launcher.label}
        </Command.Item>
      ))}
    </Command.Group>
  );
}

function ScriptItems({
  entry,
  query,
  go,
}: {
  entry: PaletteEntry;
  query: string;
  go: GoTo;
}) {
  const { worktree } = entry;
  const { data: pkg } = usePackageScripts(worktree.projectId, worktree.id);
  const { sorted } = useSortedPackageScripts(worktree.projectId, pkg);
  const scripts = rankByScore(query, sorted, (script) => script.name);
  if (scripts.length === 0) return null;
  return (
    <Command.Group heading="Scripts" className={GROUP_CLASS}>
      {scripts.map((script) => (
        <ScriptItem
          key={script.name}
          entry={entry}
          name={script.name}
          command={script.command}
          go={go}
        />
      ))}
    </Command.Group>
  );
}

// Runs the script and lands on its console, so the output is what you
// see next. One already running just opens the console.
function ScriptItem({
  entry,
  name,
  command,
  go,
}: {
  entry: PaletteEntry;
  name: string;
  command: string;
  go: GoTo;
}) {
  const slot: ScriptSlot = { kind: "package", name };
  const { busy, canRun, disabledReason, start } = useScriptRunner(
    entry.worktree,
    slot,
  );
  return (
    <Command.Item
      value={`script:${name}`}
      disabled={!busy && !canRun}
      onSelect={() => {
        if (!busy) start();
        go(entry, "script", { scriptKey: slotToParam(slot) });
      }}
      title={disabledReason ?? command}
      className={cn(ITEM_CLASS, "aria-disabled:opacity-50")}
    >
      <Play className="size-4 text-muted-foreground/80" />
      <span className="font-mono">{name}</span>
      <span className="min-w-0 flex-1 truncate text-right font-mono text-2xs text-muted-foreground">
        {busy ? "running" : command}
      </span>
    </Command.Item>
  );
}
