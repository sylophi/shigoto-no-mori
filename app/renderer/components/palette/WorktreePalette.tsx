import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useParams } from "@tanstack/react-router";
import { Command, useCommandState } from "cmdk";
import { ArrowDown, ArrowUp } from "lucide-react";
import { KbdHint } from "@/components/ui/kbd";
import { ModalShell } from "@/components/ui/modal-shell";
import {
  keepFocusInInput,
  MODAL_COMMAND_CLASS,
} from "@/components/ui/cmdk-classes";
import { BranchLabel } from "@/components/ui/branch-label";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { DeviceBadge, useDeviceBadges } from "@/components/sidebar/DeviceBadge";
import { worktreeRowKey } from "@/components/sidebar/buildSidebarRows";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { rowDeviceId } from "@/lib/routePaths";
import { useLauncherForProject } from "@/hooks/launchers/useLaunchers";
import { useLaunchShortcuts } from "@/hooks/launchers/useLaunchShortcuts";
import { useAllProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { useProjects } from "@/hooks/projects/useProjects";
import { useMirrorLinks } from "@/hooks/remote/useMirrors";
import { useRemoteForests } from "@/hooks/remote/useRemoteForests";
import { useHiddenWorktreePrefixes } from "@/hooks/sharedSettings/useHiddenWorktreePrefixes";
import { useDebouncedValue } from "@/hooks/ui/useDebouncedValue";
import { useNow } from "@/hooks/ui/useNow";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { useQuickCreateWorktree } from "@/hooks/worktrees/useQuickCreateWorktree";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import { isEditableTarget, isOverlayOpen } from "@/lib/dom";
import { hasLocalHost } from "@/lib/localHost";
import { readWorktreeVisits, recordWorktreeVisit } from "@/lib/recentWorktrees";
import { cn } from "@/lib/utils";
import {
  buildPaletteEntries,
  createTargets,
  initialPaletteKey,
  isProjectSource,
  newBranchName,
  leadingProjectCount,
  rankPaletteEntries,
  rankPaletteProjects,
} from "./buildPaletteEntries";
import { PaletteGroup, PaletteItem, PaneKeysProvider } from "./PaletteItem";
import { PaletteRowView, type PaletteRow } from "./PaletteRows";
import { PaletteVerbs, type GoTo, type PaletteActions } from "./PaletteVerbs";

// ⌘K: every worktree on every machine, one fuzzy list, and beside it
// what the highlighted one offers. ↩ jumps to it, ⌘↩ opens its
// changes, ⌘1..⌘9 open it in a launch tool, and ⇥ (or → at the end of
// the query) hands the keys to the rest: its pages, tools, git move and
// package scripts. A query also finds the projects it names, ahead of
// the worktrees when it names a project best, and offers a worktree on
// a branch of that name. A peer's worktree or project is one keystroke
// away like a local one and drawn the same, its device a badge on the
// row.
export function WorktreePalette() {
  const { paletteOpen: open, setPaletteOpen: setOpen } = useOverlays();
  // The worktree page on screen, if any, on this machine or a peer's:
  // any of its pages (detail, changes, a commit, a console) counts as
  // a visit, and the palette opens past it.
  const { deviceId, projectId, worktreeId } = useParams({
    strict: false,
  }) as {
    deviceId?: string;
    projectId?: string;
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

  // On window, so it works wherever focus sits. ⌘K fires from text
  // fields too. Ctrl+K doesn't: in a text field it is kill-line
  // (macOS's text system, and the running program's in the console's
  // terminal), so there it only closes the palette. Opening waits for any other overlay to close, and closing
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
  return (
    <PaletteDialog
      pageKey={pageKey}
      // This device's project on screen, where a new worktree goes first.
      pageProjectId={
        deviceId !== undefined && rowDeviceId(deviceId) === undefined
          ? projectId
          : undefined
      }
      onClose={() => setOpen(false)}
    />
  );
}

const GROUP_HEADINGS: Record<PaletteRow["kind"], string> = {
  worktree: "Worktrees",
  project: "Projects",
  create: "Create",
};

function PaletteDialog({
  pageKey,
  pageProjectId,
  onClose,
}: {
  pageKey: string | undefined;
  pageProjectId: string | undefined;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  // The row whose verbs have the keys, and the list's query it was
  // picked from, which the input goes back to. Null on the list.
  const [picked, setPicked] = useState<{
    row: PaletteRow;
    query: string;
  } | null>(null);
  // Read once per open: a visit recorded while the palette is up can't
  // happen, and re-reading storage every render would.
  const [visits] = useState(readWorktreeVisits);
  const { toPageOn } = useWorktreeNav();
  const { quickCreate, openCreateForm } = useQuickCreateWorktree();
  // The create under way, if any: one at a time, and its row says so.
  const [creating, setCreating] = useState<{ branch?: string } | null>(null);
  const now = useNow();

  // The sidebar's own reads, so they are warm. The sidebar's observers
  // and push invalidation keep the worktree lists fresh, so opening
  // doesn't re-list every project's worktrees in git.
  const { data: projects = [] } = useProjects();
  const worktreeQueries = useAllProjectWorktrees(projects, {
    refetchOnMount: false,
  });
  const pullRequestQueries = useAllProjectPullRequests(projects);
  const { items: remote } = useRemoteForests();
  const mirrors = useMirrorLinks();
  const deviceBadges = useDeviceBadges();
  const hiddenPrefixes = useHiddenWorktreePrefixes();
  const { entries, entryKeyOf } = buildPaletteEntries({
    projects,
    worktreeQueries,
    pullRequestQueries,
    remote,
    mirrors,
    deviceBadges,
    hiddenPrefixes,
    visits,
  });

  // The list for a query: its worktrees and the projects it names, the
  // projects it names best above the worktrees, then the worktree it
  // could make. A
  // branch a worktree here already has is found, not offered again, and
  // a pasted path or URL is no branch at all.
  const rowsFor = (listQuery: string): PaletteRow[] => {
    const shown = rankPaletteEntries(listQuery, entries);
    const worktreeRows: PaletteRow[] = shown.map((entry) => ({
      kind: "worktree",
      key: entry.key,
      entry,
    }));
    if (!listQuery) return worktreeRows;
    const named = rankPaletteProjects(listQuery, entries, projects, remote);
    const projectRows: PaletteRow[] = named.map((item) => ({
      kind: "project",
      key: item.key,
      item,
    }));
    const leading = leadingProjectCount(listQuery, named, shown);
    const rows = [
      ...projectRows.slice(0, leading),
      ...worktreeRows,
      ...projectRows.slice(leading),
    ];
    if (isProjectSource(listQuery)) return rows;
    const branch = newBranchName(listQuery);
    const [target, ...others] = hasLocalHost
      ? createTargets(projects, shown, entries, pageProjectId)
      : [];
    // A project's or device's own name is a lookup, not a branch.
    const isQuery = (name: string | undefined) =>
      name?.toLowerCase() === listQuery.toLowerCase();
    if (
      branch &&
      target &&
      !named.some((item) => isQuery(item.project.name)) &&
      !entries.some(
        (e) =>
          (!e.device && e.worktree.branch === branch) ||
          isQuery(e.device?.label),
      )
    ) {
      rows.push({
        kind: "create",
        key: "create",
        branch,
        targets: [target, ...others],
      });
    }
    return rows;
  };

  const listQuery = (picked?.query ?? query).trim();
  const rows = rowsFor(listQuery);
  // Seeded once, from the order the palette opened on (the sidebar's
  // reads are warm, so it is already filled). A query moves it to the
  // top match.
  const [highlighted, setHighlighted] = useState(() =>
    initialPaletteKey(
      rankPaletteEntries("", entries),
      pageKey && entryKeyOf(pageKey),
    ),
  );
  const current = rows.find((row) => row.key === highlighted) ?? rows[0];
  // The picked row as the list has it now, so its verbs follow a
  // refetch (a push landing, its pull request loading).
  const paneRow = picked
    ? (rows.find((row) => row.key === picked.row.key) ?? picked.row)
    : current;
  // What the pane loads for a row (its scripts, its git move, a peer's
  // over the network) waits for the highlight to rest, so arrowing
  // through the list doesn't read every row it passes.
  const settledKey = useDebouncedValue(paneRow?.key, 150);
  const paneSettled = picked !== null || settledKey === paneRow?.key;

  // The pane's worktree's tools, when it lives here (launch tools open
  // on the machine showing this window). The palette holds their
  // ⌘1..⌘9 while it is up, LauncherRow letting go, and holds them here
  // rather than in the pane, which remounts per row: arrowing between
  // worktrees then leaves the menu alone unless their tools differ.
  const launchTarget =
    hasLocalHost && paneRow?.kind === "worktree" && !paneRow.entry.device
      ? paneRow.entry.worktree
      : undefined;
  const { data: launcherData } = useLauncherForProject(
    launchTarget?.projectId ?? null,
  );
  const launchers = launchTarget ? launcherData?.entries : undefined;
  useLaunchShortcuts(launchTarget, launchers, onClose);

  // A worktree page on whichever machine the entry lives on.
  const go: GoTo = (entry, page, extra = {}) => {
    onClose();
    toPageOn(entry.device?.deviceId, page, {
      projectId: entry.worktree.projectId,
      worktreeId: entry.worktree.id,
      ...extra,
    });
  };

  const actions: PaletteActions = {
    go,
    close: onClose,
    // Up until it lands, the row saying so, then on the new page.
    // A failure toasts and leaves the palette up to try again.
    create: (projectId, branch) => {
      if (creating) return;
      setCreating({ branch });
      void quickCreate(projectId, branch).then((created) => {
        if (created) onClose();
        else setCreating(null);
      });
    },
    openCreateForm: (projectId, deviceId) => {
      onClose();
      openCreateForm(projectId, deviceId);
    },
  };

  // What ↩ does on the list: the first of the row's verbs.
  const enter = (row: PaletteRow) => {
    switch (row.kind) {
      case "worktree":
        return go(row.entry, "detail");
      case "project": {
        const { lead, project, device } = row.item;
        return lead
          ? go(lead, "detail")
          : actions.openCreateForm(project.id, device?.deviceId);
      }
      case "create":
        return actions.create(row.targets[0].id, row.branch);
    }
  };

  const pick = (row: PaletteRow) => {
    setPicked({ row, query });
    setQuery("");
    setHighlighted("");
  };

  // Back on the list with its query, the row the verbs were for (or
  // the one clicked) highlighted again. The Command remounts per stage,
  // see below.
  const back = (key = picked?.row.key ?? "") => {
    setQuery(picked?.query ?? "");
    setPicked(null);
    setHighlighted(key);
  };

  const onQueryChange = (next: string) => {
    setQuery(next);
    // On the list, the top match leads each new query. cmdk does that
    // itself for the verbs' input, which it owns.
    if (!picked) setHighlighted(rowsFor(next.trim())[0]?.key ?? "");
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (picked) {
      const atStart = e.currentTarget.selectionEnd === 0;
      if (
        (e.key === "Backspace" && query === "") ||
        (e.key === "ArrowLeft" && atStart)
      ) {
        e.preventDefault();
        back();
      } else if (e.key === "Tab") {
        // Already in the verbs. The shell doesn't trap focus, so a
        // second Tab would leave for the page underneath.
        e.preventDefault();
      }
      return;
    }
    if (!current) return;
    const atEnd = e.currentTarget.selectionStart === query.length;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      // Changes, a worktree's alone: on any other row ⌘↩ would reach
      // cmdk as a plain ↩ and run the row.
      e.preventDefault();
      e.stopPropagation();
      if (current.kind === "worktree") go(current.entry, "diff");
    } else if (e.key === "Tab" || (e.key === "ArrowRight" && atEnd)) {
      e.preventDefault();
      pick(current);
    }
  };

  // Escape backs out one stage: the verbs to the list, a query to
  // empty, then the palette itself.
  const onEscape = () => {
    if (picked) back();
    else if (query) onQueryChange("");
    else onClose();
  };

  // Headed runs of one kind, the headings only once there is more
  // than the worktrees.
  const groups: { heading: string; rows: PaletteRow[] }[] = [];
  for (const row of rows) {
    const heading = GROUP_HEADINGS[row.kind];
    const last = groups.at(-1);
    if (last?.heading === heading) last.rows.push(row);
    else groups.push({ heading, rows: [row] });
  }
  const listItems = (list: PaletteRow[]) =>
    list.map((row) => (
      <PaletteItem
        key={row.key}
        value={row.key}
        selected={picked?.row.key === row.key}
        onSelect={() => (picked ? back(row.key) : enter(row))}
      >
        <PaletteRowView
          row={row}
          query={listQuery}
          now={now}
          creating={row.kind === "create" && creating?.branch === row.branch}
        />
      </PaletteItem>
    ));

  return (
    <ModalShell
      onClose={onClose}
      onEscape={onEscape}
      // As tall as the window allows, and never resized by what it
      // shows: typing and moving the highlight leave the frame still.
      popoverClassName="h-full max-w-3xl"
    >
      {/* Keyed by stage: the pane holding the keys changes, and a fresh
          mount keeps the highlight it is handed. */}
      <Command
        key={picked ? "verbs" : "list"}
        label="Worktrees"
        loop
        shouldFilter={false}
        value={highlighted}
        onValueChange={setHighlighted}
        className={cn(MODAL_COMMAND_CLASS, "flex-1")}
      >
        <div
          data-slot="search-row"
          className="flex items-center gap-2 border-b border-border px-3 py-2"
        >
          {picked && <PickedChip row={picked.row} onBack={() => back()} />}
          {picked ? (
            <Command.Input
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- the verbs just took the keys
              autoFocus
              value={query}
              onValueChange={onQueryChange}
              onKeyDown={onInputKeyDown}
              placeholder="Search actions…"
              className={INPUT_CLASS}
            />
          ) : (
            <ListInput
              value={query}
              onValueChange={onQueryChange}
              onKeyDown={onInputKeyDown}
            />
          )}
        </div>

        {/* The panes scroll, not the list: cmdk's sizer (the list's one
            child) is the row that holds them, filling what's left. */}
        <Command.List
          onMouseDown={keepFocusInInput}
          className="flex min-h-0 flex-1 flex-col [&>[cmdk-list-sizer]]:flex [&>[cmdk-list-sizer]]:min-h-0 [&>[cmdk-list-sizer]]:flex-1"
        >
          <div
            className={cn(
              "min-w-0 flex-1 overflow-y-auto p-2",
              picked && "opacity-60 phone:hidden",
            )}
          >
            <PaneKeysProvider value={!picked}>
              {groups.length > 1
                ? groups.map((group) => (
                    // A heading can come twice (projects above and below
                    // the worktrees), its first row never.
                    <PaletteGroup
                      key={group.rows[0]?.key}
                      heading={group.heading}
                    >
                      {listItems(group.rows)}
                    </PaletteGroup>
                  ))
                : listItems(rows)}
            </PaneKeysProvider>
            {!picked && (
              <Command.Empty className={EMPTY_CLASS}>
                {entries.length === 0
                  ? "No worktrees yet."
                  : "No worktrees match."}
              </Command.Empty>
            )}
          </div>
          <div
            data-slot="palette-verbs"
            className={cn(
              "w-64 shrink-0 overflow-y-auto border-l border-border bg-muted/30 p-2 phone:w-auto phone:flex-1 phone:border-l-0",
              !picked && "phone:hidden",
            )}
          >
            <PaneKeysProvider value={picked !== null}>
              {paneRow && (
                <PaletteVerbs
                  key={paneRow.key}
                  row={paneRow}
                  query={picked ? query.trim() : ""}
                  actions={actions}
                  launchers={launchers}
                  settled={paneSettled}
                />
              )}
            </PaneKeysProvider>
            {picked && (
              <Command.Empty className={EMPTY_CLASS}>
                No actions match.
              </Command.Empty>
            )}
          </div>
        </Command.List>

        <div
          data-slot="footer-row"
          className="flex items-center gap-3 border-t border-border px-4 py-2.5 text-xs text-muted-foreground"
        >
          <KbdHint
            keys={[<ArrowUp key="up" />, <ArrowDown key="down" />]}
            label="Navigate"
          />
          <KbdHint
            keys={["↩"]}
            label={
              picked ? "Run" : current?.kind === "create" ? "Create" : "Open"
            }
          />
          {picked ? (
            <KbdHint keys={["⌫"]} label="Back" />
          ) : (
            <>
              {current?.kind === "worktree" && (
                <KbdHint keys={["⌘↩"]} label="Changes" />
              )}
              <KbdHint keys={["⇥"]} label="Actions" />
            </>
          )}
        </div>
      </Command>
    </ModalShell>
  );
}

const EMPTY_CLASS = "p-3 text-center text-xs text-muted-foreground";

const INPUT_CLASS =
  "min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground";

// The list's input. Not cmdk's own: cmdk moves the highlight to the
// first row on every change of its query, including the one that puts
// the list's query back after the verbs, which would lose the row they
// were for. The dialog picks the top match itself as the query changes.
function ListInput({
  value,
  onValueChange,
  onKeyDown,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const activeId = useCommandState((state) => state.selectedItemId);
  return (
    <input
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- the palette just opened
      autoFocus
      type="text"
      aria-activedescendant={activeId}
      aria-label="Search worktrees"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder="Search worktrees, projects, devices, PRs…"
      className={INPUT_CLASS}
    />
  );
}

// The row whose verbs have the keys, ahead of their query. A click (or
// ⌫) goes back to the list.
function PickedChip({ row, onBack }: { row: PaletteRow; onBack: () => void }) {
  return (
    <SimpleTooltip tip="Back (⌫)">
      <button
        type="button"
        onClick={onBack}
        onMouseDown={keepFocusInInput}
        className="flex max-w-[50%] shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs"
      >
        <PickedLabel row={row} />
      </button>
    </SimpleTooltip>
  );
}

function PickedLabel({ row }: { row: PaletteRow }) {
  switch (row.kind) {
    case "worktree": {
      const { worktree, project, device } = row.entry;
      return (
        <>
          <ProjectIcon
            projectId={worktree.projectId}
            name={project.name}
            deviceId={device?.deviceId}
            className="size-3"
          />
          <span className="truncate font-mono">
            <BranchLabel
              branch={worktree.branch}
              detached={worktree.detached}
            />
          </span>
          {device && <DeviceBadge badge={device} />}
        </>
      );
    }
    case "project":
      return <span className="truncate">{row.item.project.name}</span>;
    case "create":
      return <span className="truncate font-mono">{row.branch}</span>;
  }
}
