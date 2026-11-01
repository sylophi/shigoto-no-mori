import { useRef, useState, type ReactNode, type Ref } from "react";
import {
  Archive,
  ArrowLeftToLine,
  ArrowRightToLine,
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Ellipsis,
  FilePen,
  Minus,
  Search,
  Undo2,
} from "lucide-react";
import { Button } from "../../primitives/button.tsx";
import { Checkbox } from "../../primitives/checkbox.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "../../primitives/context-menu.tsx";
import { DiffStats } from "../../primitives/diff-stats.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../primitives/dropdown-menu.tsx";
import { IconButton } from "../../primitives/icon-button.tsx";
import { ModalShell } from "../../primitives/modal-shell.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { pluralize } from "@shigomori/contracts/words";
import { cn } from "../../lib/utils.ts";
import { getBrowseLeafSegment } from "@shigomori/contracts/projectPaths";
import { changeKey, type ChangedFile } from "@shigomori/contracts/schemas";
import {
  changedFilePaths,
  type DiffChangesControls,
} from "./changesControls.ts";
import { countIncluded, tickedOf, type Ticked } from "./changesPicks.ts";
import type { IndexEntry } from "../../lib/indexEntry.ts";

// Below this many files a list is short enough to scan, and a filter
// field (with a patch's fold-all beside it) would only be one more row
// between the selected row of the Git page's timeline and its files.
const FILTER_MIN_FILES = 8;

// The file list for a diff: every file in scroll order with its
// change marker and +/- counts. Order is never re-ranked, which is why
// the filter is a plain substring match and not lib/fuzzyMatch. The
// list is a map of the scroll area and has to keep its order.
//
// With `changes` it is also the changes list: a checkbox per row for
// the file's index state, a select-all box and a discard menu in the
// header, and the commit composer as its footer. A row's own actions
// (tick, copy its path, discard it) are on its context menu, opened by
// a right click or a long press, the way GitHub Desktop has them: a
// discard button on every row would cost each one width it can't
// spare. Discards, one file's or many, confirm in a dialog.
//
// A double click on a row, or its menu, opens the file in the editor.
//
// Rows arrive built (patchFiles.ts). The caller decides whether they
// come from the patch or from git status, and holds the filter.
//
// A list can run to tens of thousands of rows (an unignored build
// folder), so the app's caller draws only the rows near the view and
// hands over where each sits (`rowWindow`). A scene draws them all.
export function DiffFileIndexView({
  entries,
  query,
  onQueryChange,
  listRef,
  rowWindow,
  activeKey,
  collapsedKeys,
  onSelect,
  allCollapsed,
  onToggleAll,
  changes,
  onOpen,
  footer,
  className,
}: {
  entries: IndexEntry[];
  query: string;
  onQueryChange: (query: string) => void;
  // The list's scroll box, which the caller's window measures.
  listRef?: Ref<HTMLDivElement>;
  rowWindow?: IndexWindow;
  activeKey: string | null;
  collapsedKeys: ReadonlySet<string>;
  onSelect: (key: string) => void;
  allCollapsed: boolean;
  // Absent when the pane shows one file at a time: there is no combined
  // scroll to fold, so the header drops the control.
  onToggleAll?: () => void;
  // Present on the changes page: makes this the changes list (above).
  changes?: DiffChangesControls;
  // Opens a file in the editor. Absent where the files aren't this
  // machine's.
  onOpen?: (path: string) => void;
  footer?: ReactNode;
  // The box is the caller's too: the app sidebar's slot on a wide
  // viewport, the phone layout's bottom sheet otherwise.
  className?: string;
}) {
  // The changes list's moves, unless it only reads.
  const editable = changes && !changes.readOnly ? changes : undefined;
  // ...and the header's bulk ones, while there is something to act on.
  const bulk = editable && editable.files.length > 0 ? editable : undefined;
  const matches = matchingEntries(entries, query);

  // Which discard is up for confirmation. Its paths are worked out when
  // it is confirmed, from the rows as they are then (discardFiles).
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(
    null,
  );
  // The row whose context menu is up, or null for the list's empty
  // space, which has the header's bulk menu. One menu serves the whole
  // list, anchored at the pointer: a menu per row would mount a menu's
  // worth of state on every one of hundreds of rows to show one at a
  // time. The key outlives `open` so the menu keeps its items while it
  // closes.
  const [menu, setMenu] = useState<{
    key: string | null;
    open: boolean;
  } | null>(null);
  const menuEntry = menu && entries.find((entry) => entry.key === menu.key);
  // A long press on a touch screen can end in a click on the row it
  // opened over, which would select the file (on a phone, closing the
  // sheet the menu is in). Read at click time, so a ref.
  const menuOpenRef = useRef(false);
  const selectRow = (key: string) => {
    if (!menuOpenRef.current) onSelect(key);
  };
  const requestDiscard = (key: string) => setPendingDiscard({ key });
  const drawRow = (entry: IndexEntry) => (
    <IndexRow
      key={entry.key}
      entry={entry}
      active={entry.key === activeKey}
      collapsed={collapsedKeys.has(entry.key)}
      menuOpen={menu?.open === true && menu.key === entry.key}
      onSelect={selectRow}
      busy={changes?.busy ?? false}
      ticked={
        // A conflict goes in by being resolved, from its menu, so it
        // has no box.
        editable && entry.row && !entry.row.conflicted
          ? tickedOf(editable.picks, entry.row)
          : undefined
      }
      onSetTicked={editable?.onSetTicked}
      onDiscard={editable && requestDiscard}
      onOpen={onOpen}
    />
  );
  // The header's ⋯, a right click on the header, and one on the list's
  // empty space all open these.
  const bulkItems = bulk && (
    <ChangesMenuItems changes={bulk} onPick={setPendingDiscard} />
  );

  // Empty lists say so: a changes list in its header (or that it is
  // still loading), a patch's in the list.
  const emptyNote =
    entries.length > 0 ? (
      <p className="px-2 py-3 text-xs text-muted-foreground">
        No files match that filter.
      </p>
    ) : changes ? null : (
      <p className="px-2 py-3 text-xs text-muted-foreground">
        No changed files.
      </p>
    );

  return (
    <div data-slot="diff-index" className={cn("flex flex-col", className)}>
      {(entries.length >= FILTER_MIN_FILES || query) && (
        <div
          data-slot="search-row"
          className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5"
        >
          <Search
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground/60"
          />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                // Clear in place rather than letting Escape bubble out to
                // whatever the route does with it.
                e.stopPropagation();
                onQueryChange("");
              }
            }}
            placeholder="Filter files"
            aria-label="Filter files"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
          />
          {onToggleAll && (
            <IconButton
              size="xs"
              onClick={onToggleAll}
              aria-label={
                allCollapsed ? "Expand all files" : "Collapse all files"
              }
            >
              {allCollapsed ? (
                <ChevronsUpDown aria-hidden className="size-3.5" />
              ) : (
                <ChevronsDownUp aria-hidden className="size-3.5" />
              )}
            </IconButton>
          )}
        </div>
      )}

      {changes && (
        // The changes list's own header: the box that ticks every row,
        // what the ticks add up to, and the bulk actions, on its ⋯ and
        // on a right click anywhere on it. Nothing to tick or throw away
        // on an empty list, so there the header is just its line.
        <ContextMenu disabled={!bulkItems}>
          <ContextMenuTrigger
            render={
              <div className="flex items-center gap-2 pt-2 pr-2 pb-1 pl-3" />
            }
          >
            {bulk && <SelectAllCheckbox changes={bulk} />}
            <span className="tabular min-h-5 min-w-0 flex-1 truncate text-xs leading-5 text-muted-foreground">
              {describeSelection(changes)}
            </span>
            {bulkItems && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="Change actions"
                  render={
                    <IconButton
                      size="xs"
                      className="data-popup-open:bg-accent data-popup-open:text-foreground"
                    />
                  }
                >
                  <Ellipsis aria-hidden className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={4}>
                  {bulkItems}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </ContextMenuTrigger>
          {bulkItems && <ContextMenuContent>{bulkItems}</ContextMenuContent>}
        </ContextMenu>
      )}

      <ContextMenu
        open={menu?.open ?? false}
        onOpenChange={(open, details) => {
          if (!open) {
            menuOpenRef.current = false;
            setMenu((current) => current && { ...current, open: false });
            return;
          }
          // A row has its own menu. The list's empty space has the
          // header's, while it has one, and otherwise stays closed.
          const target = details.event.target;
          const row =
            target instanceof Element ? target.closest("[data-row-key]") : null;
          const key = row?.getAttribute("data-row-key") ?? null;
          if (key || bulkItems) {
            menuOpenRef.current = true;
            setMenu({ key, open: true });
          }
        }}
      >
        <ContextMenuTrigger
          render={
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1" />
          }
        >
          {matches.length === 0 ? (
            emptyNote
          ) : rowWindow ? (
            <div className="relative" style={{ height: rowWindow.height }}>
              {rowWindow.rows.map(({ index, start }) => {
                const entry = matches[index];
                return (
                  entry && (
                    <div
                      key={entry.key}
                      data-index={index}
                      ref={rowWindow.measureRef}
                      className="absolute inset-x-0 top-0"
                      style={{ transform: `translateY(${start}px)` }}
                    >
                      {drawRow(entry)}
                    </div>
                  )
                );
              })}
            </div>
          ) : (
            matches.map(drawRow)
          )}
        </ContextMenuTrigger>
        {menuEntry ? (
          <FileMenu
            entry={menuEntry}
            changes={editable}
            onOpen={onOpen}
            onDiscard={() => setPendingDiscard({ key: menuEntry.key })}
          />
        ) : (
          menu?.key === null &&
          bulkItems && <ContextMenuContent>{bulkItems}</ContextMenuContent>
        )}
      </ContextMenu>

      {query.trim() && matches.length > 0 && (
        <p className="border-t border-border px-2.5 py-1 text-2xs text-muted-foreground">
          {matches.length} of {entries.length} files
        </p>
      )}

      {changes && footer}

      {editable && pendingDiscard && (
        <DiscardConfirmDialog
          label={`Discard ${describeDiscard(pendingDiscard, editable)}?`}
          busy={editable.busy}
          onCancel={() => setPendingDiscard(null)}
          onConfirm={() => {
            const paths = discardPaths(pendingDiscard, editable);
            if (paths.length > 0) editable.onDiscard(paths);
            setPendingDiscard(null);
          }}
        />
      )}
    </div>
  );
}

// Where the drawn rows sit in a list too long to draw whole: the full
// list's height, and each row near the view by its index in the filtered
// list and its offset from the top.
export interface IndexWindow {
  height: number;
  rows: readonly { index: number; start: number }[];
  // Measures a drawn row, which the caller's window then places by.
  measureRef: (node: Element | null) => void;
}

// The rows a filter leaves, in list order. Order is never re-ranked,
// which is why the filter is a plain substring match (see above).
export function matchingEntries(
  entries: IndexEntry[],
  query: string,
): IndexEntry[] {
  const needle = query.trim().toLowerCase();
  return needle
    ? entries.filter(
        (entry) =>
          entry.path.toLowerCase().includes(needle) ||
          entry.prevPath?.toLowerCase().includes(needle),
      )
    : entries;
}

// Tri-state "everything" box. Reads from the status list rather than
// the patch, since that is what a commit takes. Only the rows with a box
// of their own: a conflict left out by it would stay out once resolved,
// and a merge would commit HEAD's side of it.
function SelectAllCheckbox({ changes }: { changes: DiffChangesControls }) {
  const rows = changes.files.filter((file) => !file.conflicted);
  const total = rows.length;
  const all = rows.filter(
    (file) => tickedOf(changes.picks, file) === "all",
  ).length;
  const some = countIncluded(changes.picks, rows) > 0;
  const checked = total > 0 && all === total;
  return (
    <Checkbox
      checked={checked}
      indeterminate={!checked && some}
      disabled={changes.busy || total === 0}
      onCheckedChange={(next) => changes.onSetTicked(rows, next)}
      aria-label={checked ? "Leave every file out" : "Include every file"}
      className="shrink-0"
    />
  );
}

// What the header says about the list: how many files, and how many
// of them the next commit takes when that isn't all of them.
function describeSelection(changes: DiffChangesControls): string {
  if (changes.loading) return "Loading changes…";
  if (changes.failed) return "Couldn't read the changes";
  const total = changes.files.length;
  if (total === 0) return "No changes";
  const included = countIncluded(changes.picks, changes.files);
  if (included === total) return pluralize(total, "changed file");
  return `${included} of ${pluralize(total, "file")} included`;
}

// The two bulk discards, and one file's from its row (by row key).
// "Unticked" is the one the checkbox model earns: tick what you're
// keeping, throw away the rest.
type PendingDiscard = "unticked" | "all" | { key: string };

function discardFiles(
  pending: PendingDiscard,
  { files, picks }: DiffChangesControls,
): ChangedFile[] {
  if (pending === "all") return [...files];
  if (pending === "unticked") {
    return files.filter((file) => tickedOf(picks, file) === "none");
  }
  // A file that stopped being changed while the dialog was open (an
  // editor reverted it) has nothing left to discard.
  return files.filter((file) => changeKey(file) === pending.key);
}

function discardPaths(
  pending: PendingDiscard,
  changes: DiffChangesControls,
): string[] {
  return discardFiles(pending, changes).flatMap(changedFilePaths);
}

function describeDiscard(
  pending: PendingDiscard,
  changes: DiffChangesControls,
): string {
  const picked = discardFiles(pending, changes);
  if (pending === "all") return `all ${pluralize(picked.length, "file")}`;
  if (pending === "unticked") {
    return `the ${pluralize(picked.length, "unticked file")}`;
  }
  // The whole path: two changed files can share a name.
  const path = picked[0]?.path;
  return path ? `changes to ${path}` : "changes";
}

// "Unticked" is disabled while nothing is ticked, since "the rest" would
// then be all of it and the item above already says so.
function ChangesMenuItems({
  changes,
  onPick,
}: {
  changes: DiffChangesControls;
  onPick: (pending: PendingDiscard) => void;
}) {
  const unticked = discardFiles("unticked", changes).length;
  const canDiscardUnticked =
    unticked > 0 && unticked < changes.files.length && !changes.busy;
  return (
    <>
      <DropdownMenuItem
        variant="destructive"
        disabled={changes.busy}
        onClick={() => onPick("all")}
      >
        <Undo2 />
        Discard all changes
      </DropdownMenuItem>
      <DropdownMenuItem
        variant="destructive"
        disabled={!canDiscardUnticked}
        onClick={() => onPick("unticked")}
      >
        <Undo2 />
        Discard unticked files
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={changes.busy} onClick={changes.onStash}>
        <Archive />
        Stash all changes
      </DropdownMenuItem>
    </>
  );
}

function DiscardConfirmDialog({
  label,
  busy,
  onCancel,
  onConfirm,
}: {
  label: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ModalShell label={label} onClose={onCancel} popoverClassName="max-w-md">
      <DiscardConfirmView
        label={label}
        busy={busy}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </ModalShell>
  );
}

// The discard dialog's content, which a scene draws without the shell.
export function DiscardConfirmView({
  label,
  busy,
  onCancel,
  onConfirm,
}: {
  label: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="p-5">
      <h2 className="text-base font-semibold break-words">{label}</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        The contents are snapshotted first, and the notification that follows
        has Undo.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- focus the safe action so a stray Enter cancels
          autoFocus
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={onConfirm}
          disabled={busy}
        >
          Discard
        </Button>
      </div>
    </div>
  );
}

// Its own component so moving the highlight re-renders two rows rather
// than the whole list.
function IndexRow({
  entry,
  active,
  collapsed,
  menuOpen,
  onSelect,
  busy,
  ticked,
  onSetTicked,
  onDiscard,
  onOpen,
}: {
  entry: IndexEntry;
  active: boolean;
  collapsed: boolean;
  // Its context menu is up: the row stays lit while it is.
  menuOpen: boolean;
  onSelect: (key: string) => void;
  busy: boolean;
  ticked: Ticked | undefined;
  onSetTicked: DiffChangesControls["onSetTicked"] | undefined;
  onDiscard: ((key: string) => void) | undefined;
  onOpen: ((path: string) => void) | undefined;
}) {
  // The file's name leads and its folder trails, dimmed: in a narrow
  // list the name is what tells two rows apart, so the folder is what
  // gives way when the row runs out of room.
  const name = getBrowseLeafSegment(entry.path);
  const folder = entry.path.slice(0, -name.length - 1);
  const { mark, className } = entry.mark;
  const { row } = entry;
  const select = () => onSelect(entry.key);

  return (
    // A row is two controls side by side (tick, jump), so it can't be
    // one button. The wrapper takes the click so the whole pill lands on
    // the file, the tick stops it from bubbling, and the inner button is
    // what the keyboard reaches. The wrapper also carries the key the
    // list's context menu finds it by, and it is what doubutsu paints its
    // hover treatment on (see diff-index-jump there).
    <div
      role="presentation"
      data-slot="diff-index-row"
      data-row-key={entry.key}
      onClick={select}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-2 transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent/50 hover:text-foreground",
        menuOpen && !active && "bg-accent/50",
        collapsed && "opacity-55",
      )}
    >
      {row &&
        ticked &&
        onSetTicked && (
          // The tick is the row's own control, not a way into the file:
          // its click stops here rather than selecting.
          <span
            role="presentation"
            onClick={(e) => e.stopPropagation()}
            className="flex shrink-0"
          >
            <SimpleTooltip
              tip={
                ticked === "partial"
                  ? "Partly ticked: tick to include the whole file"
                  : undefined
              }
            >
              {/* A native button: Base UI looks for a <span> checkbox's
                  <label> through its input's `labels` on every render, a
                  walk of the whole document, which a list of 2,000 rows
                  paid two seconds for. A button needs no such search. */}
              <Checkbox
                nativeButton
                render={(props) => <button type="button" {...props} />}
                checked={ticked === "all"}
                indeterminate={ticked === "partial"}
                disabled={busy}
                onCheckedChange={(next) => onSetTicked([row], next)}
                aria-label={
                  ticked === "all"
                    ? `Leave ${row.path} out of the commit`
                    : `Include ${row.path} in the commit`
                }
              />
            </SimpleTooltip>
          </span>
        )}
      <button
        type="button"
        data-slot="diff-index-jump"
        aria-current={active || undefined}
        onClick={select}
        onDoubleClick={
          onOpen && !entry.deleted ? () => onOpen(entry.path) : undefined
        }
        className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
      >
        <span
          aria-hidden
          className={cn(
            "w-2.5 shrink-0 text-center font-mono text-2xs font-semibold",
            className,
          )}
        >
          {mark}
        </span>
        {/* One line tall, clipped, and allowed to wrap: a folder with
              less than 3em left beside the name wraps onto a second
              line nobody sees, rather than showing as a sliver. */}
        <span className="flex h-[1lh] min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 overflow-hidden text-xs">
          <span className="max-w-full shrink-0 truncate">{name}</span>
          {/* Cut from its start, so what stays is the folder nearest
                the file ("…/sidebar"), the part that tells two files of
                one name apart. rtl moves the ellipsis to the left, and
                the bdi keeps the path itself reading left to right. */}
          {folder && (
            <span
              dir="rtl"
              className="min-w-[3em] flex-1 basis-0 truncate text-left text-2xs text-muted-foreground"
            >
              <bdi>{folder}</bdi>
            </span>
          )}
        </span>
        {entry.stats && (
          <DiffStats
            additions={entry.stats.additions}
            deletions={entry.stats.deletions}
            compact
          />
        )}
      </button>
      {/* A phone's list is the full width, and a long press is a gesture
          nobody finds, so there the discard is also a button. */}
      {row && onDiscard && (
        <Button
          variant="ghost-destructive"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation();
            onDiscard(entry.key);
          }}
          disabled={busy}
          aria-label={`Discard changes to ${entry.path}`}
          className="hidden phone:inline-flex"
        >
          <Undo2 aria-hidden />
        </Button>
      )}
    </div>
  );
}

// The list's context menu, for the row it opened on: tick or untick it
// and discard it on the changes page, open it in the editor and copy its
// path anywhere.
function FileMenu({
  entry,
  changes,
  onOpen,
  onDiscard,
}: {
  entry: IndexEntry;
  changes: DiffChangesControls | undefined;
  onOpen: ((path: string) => void) | undefined;
  onDiscard: () => void;
}) {
  const { row } = entry;
  const ticked = row && changes ? tickedOf(changes.picks, row) : undefined;
  return (
    <ContextMenuContent>
      {row?.conflicted && changes && (
        <>
          <DropdownMenuItem
            disabled={changes.busy}
            onClick={() => changes.onResolve(row.path, "mine")}
          >
            <ArrowLeftToLine />
            Keep mine
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={changes.busy}
            onClick={() => changes.onResolve(row.path, "theirs")}
          >
            <ArrowRightToLine />
            Take theirs
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={changes.busy}
            onClick={() => changes.onResolve(row.path, "as-is")}
          >
            <Check />
            Mark as resolved
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      {row && changes && !row.conflicted && (
        <DropdownMenuItem
          disabled={changes.busy}
          onClick={() => changes.onSetTicked([row], ticked !== "all")}
        >
          {ticked === "all" ? <Minus /> : <Check />}
          {ticked === "all"
            ? "Leave out of the commit"
            : ticked === "partial"
              ? "Include the whole file"
              : "Include in the commit"}
        </DropdownMenuItem>
      )}
      {onOpen && !entry.deleted && (
        <DropdownMenuItem onClick={() => onOpen(entry.path)}>
          <FilePen />
          Open in editor
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        onClick={() => void navigator.clipboard.writeText(entry.path)}
      >
        <Copy />
        Copy path
      </DropdownMenuItem>
      {row && changes && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={changes.busy}
            onClick={onDiscard}
          >
            <Undo2 />
            Discard changes…
          </DropdownMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}
