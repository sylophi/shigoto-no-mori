import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Ellipsis,
  Search,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DiffStats } from "@/components/ui/diff-stats";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useShortPath } from "@/hooks/ui/useShortPath";
import {
  CONFIRM_QUICK_MS,
  useConfirmTwiceKeyed,
} from "@/hooks/ui/useConfirmTwice";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import type { ChangedFile } from "@shared/schemas";
import {
  changedFilePaths,
  includedFiles,
  type DiffChangesControls,
} from "./changesControls";
import type { IndexEntry } from "./patchFiles";

// The file rail beside a diff: every file in scroll order with its
// change marker and +/- counts. Order is never re-ranked, which is why
// the filter is a plain substring match and not lib/fuzzyMatch. The
// rail is a map of the scroll area and has to keep its order.
//
// With `changes` it is also the changes list: a checkbox per row for
// the file's index state, a discard control on hover, a select-all box
// and a discard menu in the header, and the commit composer as its
// footer. Bulk discards confirm in a strip that takes the footer's
// place. Per-file discards arm on the row itself.
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
  width,
}: {
  entries: IndexEntry[];
  activeKey: string | null;
  collapsedKeys: ReadonlySet<string>;
  onSelect: (key: string) => void;
  allCollapsed: boolean;
  // Absent when the pane shows one file at a time: there is no combined
  // scroll to fold, so the header drops the control.
  onToggleAll?: () => void;
  // Visibility only. The caller owns the "is there room for a rail"
  // question because it owns the pane.
  changes?: DiffChangesControls;
  footer?: ReactNode;
  // Dragged by the caller's separator; the rail only draws it.
  width: number;
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

  // Keep the highlighted row on screen. Past ~24 files the rail is taller
  // than its own viewport, and a scroll-spy marker you can't see is no
  // marker at all. `nearest` is the minimum scroll that reveals the row,
  // so a row already in view doesn't move and reading down a patch
  // doesn't jitter.
  useEffect(() => {
    listRef.current
      ?.querySelector("[data-active]")
      ?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  const discardArm = useConfirmTwiceKeyed(CONFIRM_QUICK_MS);
  // Which bulk discard is up for confirmation. The paths are worked out
  // when it is confirmed, from the rows as they are then: the ticks stay
  // live while the strip is open, and a file ticked to keep it must not
  // go because the menu was opened a moment earlier.
  const [pendingDiscard, setPendingDiscard] = useState<BulkDiscard | null>(
    null,
  );

  return (
    <div
      data-slot="diff-index"
      style={{ width }}
      className="flex shrink-0 flex-col"
    >
      <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5">
        {changes ? (
          <SelectAllCheckbox changes={changes} />
        ) : (
          <Search
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground/60"
          />
        )}
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
        {changes && (
          <DiscardMenu
            changes={changes}
            onPick={(kind) => {
              discardArm.reset();
              setPendingDiscard(kind);
            }}
          />
        )}
        {onToggleAll && (
          <button
            type="button"
            onClick={onToggleAll}
            title={allCollapsed ? "Expand all files" : "Collapse all files"}
            aria-label={
              allCollapsed ? "Expand all files" : "Collapse all files"
            }
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

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
        {matches.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            {entries.length === 0
              ? "No changed files."
              : "No files match that filter."}
          </p>
        ) : (
          matches.map((entry) => (
            <IndexRow
              key={entry.key}
              entry={entry}
              active={entry.key === activeKey}
              collapsed={collapsedKeys.has(entry.key)}
              onSelect={onSelect}
              busy={changes?.busy ?? false}
              onSetStaged={changes?.onSetStaged}
              discardArmed={discardArm.armedKey === entry.key}
              onDiscard={() =>
                discardArm.trigger(entry.key, () => {
                  if (entry.row)
                    changes?.onDiscard(changedFilePaths(entry.row));
                })
              }
            />
          ))
        )}
      </div>

      {needle && matches.length > 0 && (
        <p className="border-t border-border px-2.5 py-1 text-[11px] text-muted-foreground">
          {matches.length} of {entries.length} files
        </p>
      )}

      {changes &&
        (pendingDiscard ? (
          <DiscardConfirmStrip
            label={`Discard ${describeBulk(pendingDiscard, changes.files)}?`}
            busy={changes.busy}
            onCancel={() => setPendingDiscard(null)}
            onConfirm={() => {
              changes.onDiscard(bulkPaths(pendingDiscard, changes.files));
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
      title={checked ? "Leave every file out" : "Include every file"}
      className="shrink-0"
    />
  );
}

// The two bulk discards. "Unticked" is the one the checkbox model
// earns: tick what you're keeping, throw away the rest.
type BulkDiscard = "unticked" | "all";

function bulkFiles(
  kind: BulkDiscard,
  files: readonly ChangedFile[],
): ChangedFile[] {
  return kind === "all"
    ? [...files]
    : files.filter((file) => file.staged === "none");
}

function bulkPaths(kind: BulkDiscard, files: readonly ChangedFile[]): string[] {
  return bulkFiles(kind, files).flatMap(changedFilePaths);
}

function describeBulk(
  kind: BulkDiscard,
  files: readonly ChangedFile[],
): string {
  const count = bulkFiles(kind, files).length;
  return kind === "all"
    ? `all ${pluralize(count, "file")}`
    : `the ${pluralize(count, "unticked file")}`;
}

// "Unticked" is disabled while nothing is ticked, since "the rest" would
// then be all of it and the item below already says so.
function DiscardMenu({
  changes,
  onPick,
}: {
  changes: DiffChangesControls;
  onPick: (kind: BulkDiscard) => void;
}) {
  const total = changes.files.length;
  const unticked = bulkFiles("unticked", changes.files).length;
  const canDiscardUnticked = unticked > 0 && unticked < total && !changes.busy;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Discard changes"
        title="Discard changes"
        disabled={total === 0}
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
      <p className="text-[11px] text-muted-foreground">
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
// than the whole rail.
function IndexRow({
  entry,
  active,
  collapsed,
  onSelect,
  busy,
  onSetStaged,
  discardArmed,
  onDiscard,
}: {
  entry: IndexEntry;
  active: boolean;
  collapsed: boolean;
  onSelect: (key: string) => void;
  busy: boolean;
  onSetStaged: ((paths: string[], staged: boolean) => void) | undefined;
  discardArmed: boolean;
  onDiscard: () => void;
}) {
  // No home to tildify against: these are repo-relative paths, so the
  // helper only does the middle-segment abbreviation ("r/c/diff/x.tsx")
  // against the measured width of this row's path column.
  const [pathRef, display] = useShortPath(entry.path, null);
  const cut = display.lastIndexOf("/");
  const { mark, label, className } = entry.mark;
  const { row } = entry;
  const select = () => onSelect(entry.key);
  const title = entry.prevPath
    ? `${label}: ${entry.prevPath} → ${entry.path}`
    : `${label}: ${entry.path}`;

  return (
    // A row is three controls side by side (tick, jump, discard), so it
    // can't be one button. The wrapper takes the click so the whole pill
    // lands on the file, the tick and the discard stop it from bubbling,
    // and the inner button is what the keyboard reaches. The wrapper
    // also carries the active marker the scroll-into-view above looks
    // for, and it is what doubutsu paints its hover treatment on (see
    // diff-index-jump there).
    <div
      role="presentation"
      data-slot="diff-index-row"
      onClick={select}
      data-active={active || undefined}
      className={cn(
        "group/row flex w-full items-center gap-1.5 rounded-md pr-1 pl-2 transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent/50 hover:text-foreground",
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
              title={
                row.staged === "partial"
                  ? "Partly staged: tick to include the whole file"
                  : row.staged === "all"
                    ? "Included in the commit"
                    : "Not included in the commit"
              }
            />
          </span>
        )}
      <button
        type="button"
        data-slot="diff-index-jump"
        onClick={select}
        title={title}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
      >
        <span
          aria-hidden
          className={cn("w-2 shrink-0 font-mono text-[10px]", className)}
        >
          {mark}
        </span>
        <span
          ref={pathRef}
          className="min-w-0 flex-1 truncate font-mono text-[11px]"
        >
          {cut >= 0 && (
            <span className="text-muted-foreground">
              {display.slice(0, cut + 1)}
            </span>
          )}
          {display.slice(cut + 1)}
        </span>
        {entry.stats && !discardArmed && (
          <DiffStats
            additions={entry.stats.additions}
            deletions={entry.stats.deletions}
          />
        )}
      </button>
      {row && (
        <Button
          variant="ghost-destructive"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            onDiscard();
          }}
          disabled={busy}
          aria-pressed={discardArmed}
          aria-label={
            discardArmed
              ? `Confirm discarding ${entry.path}`
              : `Discard changes to ${entry.path}`
          }
          title={discardArmed ? "Click again to discard" : "Discard changes"}
          className={cn(
            "h-5 shrink-0 transition-opacity",
            discardArmed
              ? "px-1.5 text-[11px] opacity-100"
              : "w-5 px-0 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
          )}
        >
          <Undo2 aria-hidden />
          {discardArmed && "Discard?"}
        </Button>
      )}
    </div>
  );
}
