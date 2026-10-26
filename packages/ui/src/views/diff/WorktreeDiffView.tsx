import type { ReactNode } from "react";
import { CircleCheck, Loader2 } from "lucide-react";
import { Kbd } from "../../primitives/kbd.tsx";

// The foot of the changes page's file list (WorktreeDiff.tsx fills it):
// where a commit lands, the last commit while it can still be amended,
// and the commit box, or on a peer that takes no commands from here, a
// note saying so.
export function ChangesFooterView({
  branchBar,
  lastCommit,
  composer,
  readOnlyNote,
}: {
  branchBar: ReactNode;
  lastCommit: ReactNode;
  composer: ReactNode;
  readOnlyNote: string | null;
}) {
  return (
    // One rhythm down the foot: rows of one height at one inset, and
    // the commit box a field's gap under them.
    <div
      data-slot="changes-footer"
      className="flex flex-col border-t border-border pt-1 pb-2.5"
    >
      {branchBar}
      {lastCommit}
      {composer}
      {readOnlyNote !== null && (
        <p className="px-3 pt-1 text-xs text-muted-foreground">
          {readOnlyNote}
        </p>
      )}
    </div>
  );
}

// What the pane says once everything is committed: that the tree is
// clean, and what the branch still owes the remote, the next thing to
// do, which the branch bar below has the button for.
export function CleanTreeMessageView({
  owed,
  shortcut,
}: {
  owed: string | null;
  // What the commit keys run here, when they run anything, and the keys,
  // or while that runs, its words ("Pushing…").
  shortcut: { keys: string; does: string; running?: string } | null;
}) {
  return (
    <span className="flex flex-col items-center gap-2">
      <CircleCheck aria-hidden className="size-6 text-muted-foreground/60" />
      <span className="text-foreground">No uncommitted changes</span>
      {owed && <span className="text-xs">{owed}</span>}
      {shortcut && (
        <span className="flex h-5 items-center gap-1.5 text-xs">
          {shortcut.running ? (
            <>
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
              {shortcut.running}
            </>
          ) : (
            <>
              <Kbd>{shortcut.keys}</Kbd>
              {shortcut.does}
            </>
          )}
        </span>
      )}
    </span>
  );
}
