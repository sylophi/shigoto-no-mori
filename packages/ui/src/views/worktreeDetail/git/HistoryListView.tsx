// The Git page's History tab (HistoryList reads the history): a search
// field, the branch's whole diff, then its commits, newest first, with
// the refs that matter drawn as lines across the list where they point.
import type { ReactNode } from "react";
import { ChevronRight, Layers, Search } from "lucide-react";
import { Input } from "../../../primitives/input.tsx";
import { SegmentedControl } from "../../../primitives/segmented-control.tsx";
import { SimpleTooltip } from "../../../primitives/tooltip.tsx";
import { pluralize } from "../../../lib/pluralize.ts";
import { cn } from "../../../lib/utils.ts";
import { HistorySelection, useRowSelection } from "./CommitRowView.tsx";

export function HistoryListView({
  selected,
  search,
  onSearchChange,
  body,
  dialog,
}: {
  // `branch` or `commit:<hash>`: what the page shows.
  selected: string | null;
  search: string;
  onSearchChange: (search: string) => void;
  // The branch's commits, or the search's.
  body: ReactNode;
  // The reword dialog, while one is open (useCommitActions).
  dialog?: ReactNode;
}) {
  return (
    <HistorySelection value={selected}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative px-2 pb-2">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-4.5 -mt-1 size-3.5 -translate-y-1/2 text-muted-foreground/60"
          />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && search) {
                e.stopPropagation();
                onSearchChange("");
              }
            }}
            placeholder="Search commit messages"
            aria-label="Search commit messages"
            spellCheck={false}
            className="w-full py-1.5 pr-2.5 pl-7 text-xs"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">{body}</div>
        {dialog}
      </div>
    </HistorySelection>
  );
}

// A ref, drawn as a line across the list at the commit it points to,
// like a "new messages" line: its name, the rule, and its one move.
export function RefLineView({
  icon,
  name,
  mono = false,
  tip,
  action,
}: {
  icon: ReactNode;
  name: string;
  mono?: boolean;
  tip: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center gap-2 px-2 py-1">
      <SimpleTooltip tip={tip}>
        <span className="flex min-w-0 shrink items-center gap-1.5 text-2xs text-muted-foreground">
          <span className="shrink-0">{icon}</span>
          <span className={cn("truncate", mono && "font-mono")}>{name}</span>
        </span>
      </SimpleTooltip>
      <span
        aria-hidden
        className="h-px min-w-2 flex-1 bg-muted-foreground/25"
      />
      {action && <span className="flex shrink-0 items-center">{action}</span>}
    </div>
  );
}

// A ref's line with nothing to do: the remote has it all.
export function UpToDateView() {
  return <span className="text-2xs text-muted-foreground">Up to date</span>;
}

// A split's leading line (its ref line), the two sides to pick between,
// and the move that brings them together.
export function SplitHeaderView({
  refLine,
  side,
  onSide,
  hereCount,
  remoteLabel,
  pill,
}: {
  refLine: ReactNode;
  side: "here" | "remote";
  onSide: (side: "here" | "remote") => void;
  hereCount: number;
  remoteLabel: string;
  // The branch's sync (WorktreeSyncPill).
  pill: ReactNode;
}) {
  return (
    <div className="pb-1">
      {refLine}
      <div className="flex flex-wrap items-center justify-end gap-2 px-2">
        <SegmentedControl
          aria-label="Side of the split"
          className="min-w-32 flex-1"
          optionClassName="flex-1 justify-center px-1 py-0.5 text-xs"
          value={side}
          onChange={onSide}
          options={[
            { value: "here", label: `Here ${hereCount}` },
            { value: "remote", label: remoteLabel },
          ]}
        />
        {pill}
      </div>
    </div>
  );
}

// The branch's whole diff, picked like a commit. How far the primary
// branch has moved on since is the footer's to say, beside its sync.
export function BranchChangesRowView({
  base,
  own,
  more,
  onOpen,
}: {
  base: string;
  own: number;
  more: boolean;
  onOpen: () => void;
}) {
  const selected = useRowSelection("branch");
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      onClick={onOpen}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      <Layers
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs">All branch changes</span>
        <span className="block truncate text-2xs text-muted-foreground">
          {more ? `${own}+ commits` : pluralize(own, "commit")} since {base}
        </span>
      </span>
    </button>
  );
}

// The fold over the history before the branch.
export function EarlierToggleView({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      Earlier commits
      <ChevronRight
        aria-hidden
        className={cn("size-3.5 transition-transform", open && "rotate-90")}
      />
    </button>
  );
}

// The next page of commits, on request.
export function ShowMoreView({
  pending,
  onLoad,
}: {
  pending: boolean;
  onLoad: () => void;
}) {
  return (
    <button
      type="button"
      disabled={pending}
      onClick={onLoad}
      className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
    >
      {pending ? "Loading…" : "Show more"}
    </button>
  );
}

export function NoteView({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-1.5 text-xs text-muted-foreground">{children}</p>
  );
}
