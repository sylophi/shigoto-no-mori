import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Ellipsis,
  Minus,
  Search,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { DiffStats } from "@/components/ui/diff-stats";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { changeKey, type ChangedFile } from "@shared/schemas";
import {
  changedFilePaths,
  includedFiles,
  type DiffChangesControls,
} from "./changesControls";
import type { IndexEntry } from "@/lib/patchFiles";

// Below this many files the changes list is short enough to scan, and
// a filter field would only be one more row between the header and
// the files. A read-only patch keeps its filter: that row also holds
// the fold-all control.
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
// spare. Discards, one file's or many, confirm in a strip that takes
// the footer's place.
//
// Rows arrive built (patchFiles.ts). The caller decides whether they
// come from the patch or from git status.
export function DiffFileIndex({
  entries,
  activeKey,
  collapsedKeys,
  onSelect,
  allCollapsed,
  onToggleAll,
  changes,
  footer,
  className,
}: {
  entries: IndexEntry[];
  activeKey: string | null;
  collapsedKeys: ReadonlySet<string>;
  onSelect: (key: string) => void;
  allCollapsed: boolean;
  // Absent when the pane shows one file at a time: there is no combined
  // scroll to fold, so the header drops the control.
  onToggleAll?: () => void;
  // Present on the changes page: makes this the changes list (above).
  changes?: DiffChangesControls;
  footer?: ReactNode;
  // The box is the caller's too: the app sidebar's slot on a wide
  // viewport, the phone layout's bottom sheet otherwise.
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? entries.filter(
        (entry) =>
          entry.path.toLowerCase().includes(needle) ||
          entry.prevPath?.toLowerCase().includes(needle),
      )
    : entries;

  // Keep the highlighted row on screen. Past ~24 files the list is taller
  // than its own viewport, and a scroll-spy marker you can't see is no
  // marker at all. `nearest` is the minimum scroll that reveals the row,
  // so a row already in view doesn't move and reading down a patch
  // doesn't jitter.
  useEffect(() => {
    listRef.current
      ?.querySelector("[data-active]")
      ?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  // Which discard is up for confirmation. The paths are worked out
  // when it is confirmed, from the rows as they are then: the ticks stay
  // live while the strip is open, and a file ticked to keep it must not
  // go because the menu was opened a moment earlier.
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(
    null,
  );

  return (
    <div data-slot="diff-index" className={cn("flex flex-col", className)}>
      {(!changes || entries.length >= FILTER_MIN_FILES || query) && (
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
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                // Clear in place rather than letting Escape bubble out to
                // whatever the route does with it.
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Filter files"
            aria-label="Filter files"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
          />
          {onToggleAll && (
            <button
              type="button"
              onClick={onToggleAll}
              aria-label={
                allCollapsed ? "Expand all files" : "Collapse all files"
              }
              data-icon-button
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {allCollapsed ? (
                <ChevronsUpDown aria-hidden className="size-3.5" />
              ) : (
                <ChevronsDownUp aria-hidden className="size-3.5" />
              )}
            </button>
          )}
        </div>
      )}

      {changes && (
        // The changes list's own header: the box that ticks every row,
        // what the ticks add up to, and the bulk discards.
        <div className="flex items-center gap-2 pt-2 pr-2 pb-1 pl-3">
          {/* Nothing to tick or throw away on an empty list, so the
              header is just its line. */}
          {changes.files.length > 0 && <SelectAllCheckbox changes={changes} />}
          <span className="tabular min-h-5 min-w-0 flex-1 truncate text-xs leading-5 text-muted-foreground">
            {describeSelection(changes)}
          </span>
          {changes.files.length > 0 && (
            <DiscardMenu changes={changes} onPick={setPendingDiscard} />
          )}
        </div>
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
        {/* An empty changes list has its header to say so (or that
            it is still loading). */}
        {matches.length === 0
          ? (!changes || entries.length > 0) && (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {entries.length === 0
                  ? "No changed files."
                  : "No files match that filter."}
              </p>
            )
          : matches.map((entry) => (
              <IndexRow
                key={entry.key}
                entry={entry}
                active={entry.key === activeKey}
                collapsed={collapsedKeys.has(entry.key)}
                onSelect={onSelect}
                busy={changes?.busy ?? false}
                onSetStaged={changes?.onSetStaged}
                onDiscard={() => setPendingDiscard({ key: entry.key })}
              />
            ))}
      </div>

      {needle && matches.length > 0 && (
        <p className="border-t border-border px-2.5 py-1 text-2xs text-muted-foreground">
          {matches.length} of {entries.length} files
        </p>
      )}

      {changes &&
        (pendingDiscard ? (
          <DiscardConfirmStrip
            label={`Discard ${describeDiscard(pendingDiscard, changes.files)}?`}
            busy={changes.busy}
            onCancel={() => setPendingDiscard(null)}
            onConfirm={() => {
              const paths = discardPaths(pendingDiscard, changes.files);
              if (paths.length > 0) changes.onDiscard(paths);
              setPendingDiscard(null);
            }}
          />
        ) : (
          footer
        ))}
    </div>
  );
}

// Tri-state "everything" box. Reads from the status list rather than
// the patch, since that is what a commit takes. Ticking it stages every
// changed path, unticking clears the index.
function SelectAllCheckbox({ changes }: { changes: DiffChangesControls }) {
  const total = changes.files.length;
  const all = changes.files.filter((file) => file.staged === "all").length;
  const some = includedFiles(changes.files).length > 0;
  const checked = total > 0 && all === total;
  return (
    <Checkbox
      checked={checked}
      indeterminate={!checked && some}
      disabled={changes.busy || total === 0}
      onCheckedChange={(next) =>
        changes.onSetStaged(changes.files.flatMap(changedFilePaths), next)
      }
      aria-label={checked ? "Leave every file out" : "Include every file"}
      className="shrink-0"
    />
  );
}

// What the header says about the list: how many files, and how many
// of them the next commit takes when that isn't all of them.
function describeSelection(changes: DiffChangesControls): string {
  if (changes.loading) return "Loading changes…";
  const total = changes.files.length;
  if (total === 0) return "No changes";
  const included = includedFiles(changes.files).length;
  if (included === 0 || included === total) {
    return pluralize(total, "changed file");
  }
  return `${included} of ${pluralize(total, "file")} included`;
}

// The two bulk discards, and one file's from its row (by row key).
// "Unticked" is the one the checkbox model earns: tick what you're
// keeping, throw away the rest.
type BulkDiscard = "unticked" | "all";
type PendingDiscard = BulkDiscard | { key: string };

function discardFiles(
  pending: PendingDiscard,
  files: readonly ChangedFile[],
): ChangedFile[] {
  if (pending === "all") return [...files];
  if (pending === "unticked") {
    return files.filter((file) => file.staged === "none");
  }
  // A file that stopped being changed while the strip was open (an
  // editor reverted it) has nothing left to discard.
  return files.filter((file) => changeKey(file) === pending.key);
}

function discardPaths(
  pending: PendingDiscard,
  files: readonly ChangedFile[],
): string[] {
  return discardFiles(pending, files).flatMap(changedFilePaths);
}

function describeDiscard(
  pending: PendingDiscard,
  files: readonly ChangedFile[],
): string {
  const picked = discardFiles(pending, files);
  if (pending === "all") return `all ${pluralize(picked.length, "file")}`;
  if (pending === "unticked") {
    return `the ${pluralize(picked.length, "unticked file")}`;
  }
  const path = picked[0]?.path;
  return path
    ? `changes to ${path.slice(path.lastIndexOf("/") + 1)}`
    : "changes";
}

// "Unticked" is disabled while nothing is ticked, since "the rest" would
// then be all of it and the item below already says so.
function DiscardMenu({
  changes,
  onPick,
}: {
  changes: DiffChangesControls;
  onPick: (pending: PendingDiscard) => void;
}) {
  const total = changes.files.length;
  const unticked = discardFiles("unticked", changes.files).length;
  const canDiscardUnticked = unticked > 0 && unticked < total && !changes.busy;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Discard changes"
        disabled={total === 0}
        data-icon-button
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 data-popup-open:bg-accent data-popup-open:text-foreground"
      >
        <Ellipsis aria-hidden className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-48">
        <DropdownMenuItem
          variant="destructive"
          disabled={!canDiscardUnticked}
          onClick={() => onPick("unticked")}
        >
          <Undo2 />
          Discard unticked files
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          disabled={changes.busy}
          onClick={() => onPick("all")}
        >
          <Undo2 />
          Discard all changes
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DiscardConfirmStrip({
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
    <div className="flex flex-col gap-2 border-t border-border p-3">
      <p className="text-xs font-medium">{label}</p>
      <p className="text-2xs text-muted-foreground">
        The contents are snapshotted first, and the notification that follows
        has Undo.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="xs" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="xs"
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? "Discarding…" : "Discard"}
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
  onSelect,
  busy,
  onSetStaged,
  onDiscard,
}: {
  entry: IndexEntry;
  active: boolean;
  collapsed: boolean;
  onSelect: (key: string) => void;
  busy: boolean;
  onSetStaged: ((paths: string[], staged: boolean) => void) | undefined;
  onDiscard: () => void;
}) {
  // The file's name leads and its folder trails, dimmed: in a narrow
  // list the name is what tells two rows apart, so the folder is what
  // gives way when the row runs out of room.
  const cut = entry.path.lastIndexOf("/");
  const name = entry.path.slice(cut + 1);
  const folder = cut >= 0 ? entry.path.slice(0, cut) : "";
  const { mark, label, className } = entry.mark;
  const { row } = entry;
  const select = () => onSelect(entry.key);
  // The context menu is a gesture nothing on the row shows, so the
  // row's hint names it.
  const tip = [
    entry.prevPath
      ? `${label}: ${entry.prevPath} → ${entry.path}`
      : `${label}: ${entry.path}`,
    row && "Right-click to discard or copy the path",
  ]
    .filter(Boolean)
    .join("\n");

  const rowElement = (
    // A row is two controls side by side (tick, jump), so it can't be
    // one button. The wrapper takes the click so the whole pill lands on
    // the file, the tick stops it from bubbling, and the inner button is
    // what the keyboard reaches. The wrapper also carries the active
    // marker the scroll-into-view above looks for, it is what doubutsu
    // paints its hover treatment on (see diff-index-jump there), and it
    // is the context menu's trigger, lit while the menu is open.
    <div
      role="presentation"
      data-slot="diff-index-row"
      onClick={select}
      data-active={active || undefined}
      className={cn(
        "group/row flex w-full items-center gap-1.5 rounded-md pr-2 pl-2 transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent/50 hover:text-foreground data-popup-open:bg-accent/50",
        collapsed && "opacity-55",
      )}
    >
      {row &&
        onSetStaged && (
          // The tick is the row's own control, not a way into the file:
          // its click stops here rather than selecting.
          <span
            role="presentation"
            onClick={(e) => e.stopPropagation()}
            className="flex shrink-0"
          >
            <SimpleTooltip
              tip={
                row.staged === "partial"
                  ? "Partly staged: tick to include the whole file"
                  : undefined
              }
            >
              <Checkbox
                checked={row.staged === "all"}
                indeterminate={row.staged === "partial"}
                disabled={busy}
                onCheckedChange={(next) =>
                  onSetStaged(changedFilePaths(row), next)
                }
                aria-label={
                  row.staged === "all"
                    ? `Leave ${row.path} out of the commit`
                    : `Include ${row.path} in the commit`
                }
              />
            </SimpleTooltip>
          </span>
        )}
      <SimpleTooltip tip={tip}>
        <button
          type="button"
          data-slot="diff-index-jump"
          onClick={select}
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
      </SimpleTooltip>
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger render={rowElement} />
      <ContextMenuContent className="min-w-48">
        {row && onSetStaged && (
          <DropdownMenuItem
            disabled={busy}
            onClick={() =>
              onSetStaged(changedFilePaths(row), row.staged !== "all")
            }
          >
            {row.staged === "all" ? <Minus /> : <Check />}
            {row.staged === "all"
              ? "Leave out of the commit"
              : "Include in the commit"}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => void navigator.clipboard.writeText(entry.path)}
        >
          <Copy />
          Copy path
        </DropdownMenuItem>
        {row && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={busy}
              onClick={onDiscard}
            >
              <Undo2 />
              Discard changes…
            </DropdownMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
