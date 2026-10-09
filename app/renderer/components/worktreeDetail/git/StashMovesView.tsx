import { ArchiveRestore, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// Under a stash's title on the Stashes tab: put it back (and drop it,
// or keep it), or drop it. A restore lands on the changes it went back
// into. A drop moves on to the next stash, or to the tab's empty state
// once none is left. None on a peer that takes no commands from here
// (StashMoves binds them).
export function StashMovesView({
  busy,
  onRestore,
  onRestoreAndKeep,
  onDrop,
}: {
  // A restore or a drop is under way.
  busy: boolean;
  onRestore: () => void;
  onRestoreAndKeep: () => void;
  onDrop: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <Button variant="outline" size="xs" disabled={busy} onClick={onRestore}>
        <ArchiveRestore />
        Restore
      </Button>
      <Button
        variant="outline"
        size="xs"
        disabled={busy}
        onClick={onRestoreAndKeep}
      >
        <ArchiveRestore />
        Restore and keep it
      </Button>
      <Button
        variant="outline-destructive"
        size="xs"
        disabled={busy}
        onClick={onDrop}
      >
        <Trash2 />
        Drop
      </Button>
    </div>
  );
}
