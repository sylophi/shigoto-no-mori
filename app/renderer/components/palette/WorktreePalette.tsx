import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useParams } from "@tanstack/react-router";
import { ModalShell } from "@/components/ui/modal-shell";

import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { useDeviceBadges } from "@/components/sidebar/deviceBadges";
import { worktreeRowKey } from "@/components/sidebar/buildSidebarRows";
import { rowDeviceId } from "@/lib/routePaths";
import { useLauncherForProject } from "@/hooks/launchers/useLaunchers";
import { useLaunchShortcuts } from "@/hooks/launchers/useLaunchShortcuts";
import { useAllProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { useProjects } from "@/hooks/projects/useProjects";
import { useMirrorLinks } from "@/hooks/remote/useMirrors";
import { useRemoteForests } from "@/hooks/remote/useRemoteForests";
import { useAllowAgentWorking } from "@/hooks/config/useSidebarMarks";
import { useWorktreePrefixes } from "@/hooks/sharedSettings/useWorktreePrefixes";
import { useDebouncedValue } from "@/hooks/ui/useDebouncedValue";
import { useNow } from "@/hooks/ui/useNow";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { useQuickCreateWorktree } from "@/hooks/worktrees/useQuickCreateWorktree";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import { isEditableTarget, isOverlayOpen } from "@/lib/dom";
import { hasLocalHost } from "@/lib/localHost";
import { readWorktreeVisits, recordWorktreeVisit } from "@/lib/recentWorktrees";
import { scoreFields } from "@/lib/fuzzyMatch";
import {
  buildPaletteEntries,
  createTargets,
  initialPaletteKey,
  isProjectSource,
  newBranchName,
  leadingCount,
  pageFields,
  projectNames,
  rankPaletteEntries,
  rankPalettePages,
  rankPaletteProjects,
} from "./buildPaletteEntries";
import { PaletteGroupView, PaletteItemView } from "./PaletteItemView";
import { PaletteRowContent, type PaletteRow } from "./PaletteRows";
import { PaletteVerbs, type GoTo, type PaletteActions } from "./PaletteVerbs";
import { usePalettePages } from "./usePalettePages";
import { PaletteDialogView, PickedChipView } from "./WorktreePaletteView";

// ⌘K: every worktree on every machine, one fuzzy list, and beside it
// what the highlighted one offers. ↩ jumps to it, ⌘↩ opens its
// changes, ⌘1..⌘9 open it in a launch tool, and ⇥ (or → at the end of
// the query) hands the keys to the rest: its pages, tools, git move and
// package scripts. A query also finds the projects and the app's pages
// it names, ahead of the worktrees when it names one best, and offers a
// worktree on a branch of that name. A peer's worktree or project is one keystroke
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
  page: "Pages",
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
  const hiddenPrefixes = useWorktreePrefixes("hidden");
  const allowAgentWorking = useAllowAgentWorking();
  const pages = usePalettePages();
  const { entries, entryKeyOf } = buildPaletteEntries({
    projects,
    worktreeQueries,
    pullRequestQueries,
    remote,
    mirrors,
    deviceBadges,
    hiddenPrefixes,
    allowAgentWorking,
    visits,
  });

  // The list for a query: its worktrees and the projects and pages it
  // names, those it names best above the worktrees, then the worktree
  // it could make. A branch a worktree here already has is found, not
  // offered again, and a pasted path or URL is no branch at all.
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
    const leading = leadingCount(
      listQuery,
      named,
      (item) => projectNames(item.project),
      shown,
    );
    const namedPages = rankPalettePages(listQuery, pages);
    const pageRows: PaletteRow[] = namedPages.map((page) => ({
      kind: "page",
      key: page.key,
      page,
    }));
    const leadingPages = leadingCount(listQuery, namedPages, pageFields, shown);
    // Projects and pages ahead of the worktrees go best first, whichever
    // kind, so ↩ on "live" opens the page and not a project "lively".
    const namedScore = (row: PaletteRow) =>
      scoreFields(
        listQuery,
        row.kind === "project"
          ? projectNames(row.item.project)
          : row.kind === "page"
            ? pageFields(row.page)
            : [],
      );
    const rows = [
      ...[
        ...projectRows.slice(0, leading),
        ...pageRows.slice(0, leadingPages),
      ].toSorted((a, b) => namedScore(b) - namedScore(a)),
      ...worktreeRows,
      ...projectRows.slice(leading),
      ...pageRows.slice(leadingPages),
    ];
    if (isProjectSource(listQuery)) return rows;
    const branch = newBranchName(listQuery);
    const [target, ...others] = hasLocalHost
      ? createTargets(projects, shown, entries, pageProjectId)
      : [];
    // A name a project, page or device answers to is a lookup, not a
    // branch.
    const isQuery = (name: string | undefined) =>
      name?.toLowerCase() === listQuery.toLowerCase();
    if (
      branch &&
      target &&
      !named.some((item) => projectNames(item.project).some(isQuery)) &&
      !namedPages.some((page) => pageFields(page).some(isQuery)) &&
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
    openPage: (page) => {
      onClose();
      page.open();
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
      case "page":
        return actions.openPage(row.page);
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
      <PaletteItemView
        key={row.key}
        value={row.key}
        selected={picked?.row.key === row.key}
        onSelect={() => (picked ? back(row.key) : enter(row))}
      >
        <PaletteRowContent
          row={row}
          query={listQuery}
          now={now}
          creating={row.kind === "create" && creating?.branch === row.branch}
        />
      </PaletteItemView>
    ));

  return (
    <ModalShell
      onClose={onClose}
      onEscape={onEscape}
      // As tall as the window allows, and never resized by what it
      // shows: typing and moving the highlight leave the frame still.
      popoverClassName="h-full max-w-3xl"
    >
      <PaletteDialogView
        picked={picked !== null}
        highlighted={highlighted}
        onHighlight={setHighlighted}
        chip={
          picked && (
            <PickedChipView
              row={picked.row}
              icon={
                picked.row.kind === "worktree" && (
                  <ProjectIcon
                    projectId={picked.row.entry.worktree.projectId}
                    name={picked.row.entry.project.name}
                    deviceId={picked.row.entry.device?.deviceId}
                    className="size-3"
                  />
                )
              }
              onBack={() => back()}
            />
          )
        }
        query={query}
        onQueryChange={onQueryChange}
        onInputKeyDown={onInputKeyDown}
        list={
          groups.length > 1
            ? groups.map((group) => (
                // A heading can come twice (projects above and below
                // the worktrees), its first row never.
                <PaletteGroupView
                  key={group.rows[0]?.key}
                  heading={group.heading}
                >
                  {listItems(group.rows)}
                </PaletteGroupView>
              ))
            : listItems(rows)
        }
        emptyList={
          entries.length === 0 ? "No worktrees yet." : "No worktrees match."
        }
        verbs={
          paneRow && (
            <PaletteVerbs
              key={paneRow.key}
              row={paneRow}
              query={picked ? query.trim() : ""}
              actions={actions}
              launchers={launchers}
              settled={paneSettled}
            />
          )
        }
        current={current?.kind}
      />
    </ModalShell>
  );
}
