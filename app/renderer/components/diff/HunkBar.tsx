import type { DiffLineAnnotation, FileDiffMetadata } from "@pierre/diffs";
import { Undo2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import type { LineChange } from "@shared/schemas";
import type { Ticked } from "./changesPicks";

// What the changes page hands the pane for the picked file when it
// ticks by hunk (a modified file): its changes, which of them are
// ticked, and the two moves.
export interface HunkControls {
  changes: readonly LineChange[];
  picked: readonly LineChange[];
  onSetTicked: (changes: LineChange[], ticked: boolean) => void;
  onDiscard: (changes: LineChange[]) => void;
}

// One hunk of the pane's diff and the changes it holds. The pane's
// hunks carry context, so one can hold several of the zero-context
// changes the host ticks, each placed by its range in HEAD.
export interface HunkGroup {
  changes: LineChange[];
  ticked: Ticked;
}

const changeFrom = (c: LineChange) =>
  c.oldCount === 0 ? c.oldStart : c.oldStart - 1;

export function hunkAnnotations(
  fileDiff: FileDiffMetadata,
  controls: HunkControls,
): DiffLineAnnotation<HunkGroup>[] {
  return fileDiff.hunks.flatMap((hunk): DiffLineAnnotation<HunkGroup>[] => {
    // Where it starts in HEAD, as changeFrom counts it: a hunk with no
    // old lines (a file empty in HEAD) sits at its start line itself.
    const from =
      hunk.deletionCount === 0 ? hunk.deletionStart : hunk.deletionStart - 1;
    const to = from + hunk.deletionCount;
    const held = controls.changes.filter(
      (c) => changeFrom(c) >= from && changeFrom(c) + c.oldCount <= to,
    );
    if (held.length === 0) return [];
    const count = held.filter((c) => controls.picked.includes(c)).length;
    const ticked: Ticked =
      count === 0 ? "none" : count === held.length ? "all" : "partial";
    // Under the hunk's last row, on whichever side it has rows.
    const metadata = { changes: held, ticked };
    return [
      hunk.additionCount > 0
        ? {
            side: "additions",
            lineNumber: hunk.additionStart + hunk.additionCount - 1,
            metadata,
          }
        : {
            side: "deletions",
            lineNumber: hunk.deletionStart + hunk.deletionCount - 1,
            metadata,
          },
    ];
  });
}

export function HunkBar({
  group,
  controls,
  busy,
}: {
  group: HunkGroup;
  controls: HunkControls;
  busy: boolean;
}) {
  return (
    <div className="flex items-center gap-3 border-y border-border/60 bg-muted/40 px-3 py-1 font-sans text-xs">
      <label className="flex items-center gap-1.5">
        <Checkbox
          checked={group.ticked === "all"}
          indeterminate={group.ticked === "partial"}
          disabled={busy}
          onCheckedChange={(next) => controls.onSetTicked(group.changes, next)}
        />
        <span>Include in commit</span>
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() => controls.onDiscard(group.changes)}
        className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
      >
        <Undo2 aria-hidden className="size-3.5" />
        Discard
      </button>
    </div>
  );
}
