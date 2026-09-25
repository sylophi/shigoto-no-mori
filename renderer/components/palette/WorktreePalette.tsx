import { useEffect, useState, type KeyboardEvent } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
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
import { sortEntries } from "@/components/worktreeDetail/scripts/sortPackageScripts";
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
import {
  NO_ORDER,
  usePackageScriptOrder,
  usePackageScriptSort,
} from "@/hooks/scripts/usePackageScriptSort";
import { useScriptRunner } from "@/hooks/scripts/useScriptRunner";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import { isOverlayOpen, isRawKeySurface } from "@/lib/dom";
import { rankByScore } from "@/lib/fuzzyMatch";
import { hasLocalHost } from "@/lib/localHost";
import { readWorktreeVisits } from "@/lib/recentWorktrees";
import { WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";
import { cn } from "@/lib/utils";
import { slotToParam, type ScriptSlot } from "@/store/scriptSlot";
import {
  buildPaletteEntries,
  initialPaletteKey,
  paletteEntryKey,
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
  const [open, setOpen] = useState(false);

  // On window, like the launcher's backtick, so it works wherever focus
  // sits. A modifier chord, so it fires from text fields too. The one
  // exception is Ctrl+K inside the script console's terminal, where it
  // is the running program's kill-line. Opening waits for any other
  // overlay to close; closing is the palette's own toggle.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || e.repeat || e.isComposing) return;
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.ctrlKey && isRawKeySurface(e.target)) return;
      if (!open && isOverlayOpen()) return;
      e.preventDefault();
      setOpen(!open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  return <PaletteDialog onClose={() => setOpen(false)} />;
}

type GoTo = (
  entry: PaletteEntry,
  page: "detail" | "diff" | "script",
  extra?: { scriptKey?: string },
) => void;

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  // The worktree whose actions are showing, or null on the list.
  const [picked, setPicked] = useState<PaletteEntry | null>(null);
  // Read once per open: a visit recorded while the palette is up can't
  // happen, and re-reading storage every render would.
  const [visits] = useState(readWorktreeVisits);
  const navigate = useNavigate();
  // The worktree page on screen, if any, on this machine or a peer's.
  const { deviceId: pageDeviceId, worktreeId: pageWorktreeId } = useParams({
    strict: false,
  }) as { deviceId?: string; worktreeId?: string };

  // The sidebar's own reads, so they are warm and cost nothing extra.
  const { data: projects = [] } = useProjects();
  const worktreeQueries = useAllProjectWorktrees(projects);
  const { items: remote } = useRemoteForests();
  const mirrors = useMirrorLinks();
  const deviceBadges = useDeviceBadges();
  const entries = buildPaletteEntries({
    projects,
    worktreeQueries,
    remote,
    mirrors,
    deviceBadges,
    visits,
  });
  const shown = rankPaletteEntries(query.trim(), entries);
  // Seeded once, from the order the palette opened on (the sidebar's
  // reads are warm, so it is already filled). cmdk takes over from
  // there, moving to the top match as the query changes.
  const [highlighted, setHighlighted] = useState(() =>
    initialPaletteKey(
      entries,
      pageWorktreeId && paletteEntryKey(pageDeviceId, pageWorktreeId),
    ),
  );
  const current = shown.find((entry) => entry.key === highlighted) ?? shown[0];

  // A worktree page on whichever machine the entry lives on: the local
  // route, or the device twin (the pattern useWorktreeNav follows for
  // the scope it is mounted in; the palette spans every scope at once).
  const go: GoTo = (entry, page, extra = {}) => {
    onClose();
    const paths = WORKTREE_ROUTE_PATHS[page];
    const params = {
      projectId: entry.worktree.projectId,
      worktreeId: entry.worktree.id,
      ...extra,
    };
    void navigate(
      (entry.device
        ? {
            to: paths.remote,
            params: { ...params, deviceId: entry.device.deviceId },
          }
        : { to: paths.local, params }) as never,
    );
  };

  const pick = (entry: PaletteEntry) => {
    setPicked(entry);
    setQuery("");
    setHighlighted("");
  };

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
      }
      return;
    }
    if (!current) return;
    const atEnd = e.currentTarget.selectionStart === query.length;
    if (e.key === "Enter" && e.metaKey) {
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
      <Command
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
  const rank: Rank = (items, text) => rankByScore(query, items, text);
  const pages = rank(PAGE_ACTIONS, (action) => action.label);
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
        <LauncherItems entry={entry} rank={rank} onClose={onClose} />
      )}
      {reachable && (
        <MaybeHostScope deviceId={deviceId ?? ""} api={api}>
          <ScriptItems entry={entry} rank={rank} go={go} />
        </MaybeHostScope>
      )}
    </>
  );
}

type Rank = <T>(items: readonly T[], text: (item: T) => string) => readonly T[];

const PAGE_ACTIONS = [
  { page: "detail", label: "Open worktree", Icon: Folder },
  { page: "diff", label: "Open changes", Icon: FileDiff },
] as const;

const GROUP_CLASS =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground";

function LauncherItems({
  entry,
  rank,
  onClose,
}: {
  entry: PaletteEntry;
  rank: Rank;
  onClose: () => void;
}) {
  const { data } = useLauncherForProject(entry.worktree.projectId);
  const launch = useLaunch();
  const launchers = rank(
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
  rank,
  go,
}: {
  entry: PaletteEntry;
  rank: Rank;
  go: GoTo;
}) {
  const { worktree } = entry;
  const { data: pkg } = usePackageScripts(worktree.projectId, worktree.id);
  const { data: sortMode = "frequent" } = usePackageScriptSort(
    worktree.projectId,
  );
  const { data: order = NO_ORDER } = usePackageScriptOrder(
    worktree.projectId,
    sortMode,
  );
  if (!pkg) return null;
  const scripts = rank(
    sortEntries(Object.entries(pkg.scripts), sortMode, pkg.usage, order),
    (script) => script.name,
  );
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
