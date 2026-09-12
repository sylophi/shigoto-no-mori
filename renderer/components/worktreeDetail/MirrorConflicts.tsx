// The conflict list behind the mirror's conflict chip. A path both
// devices changed since they last agreed is held still by the engine:
// neither copy is overwritten, while everything else keeps moving.
// Those paths used to live in the chip's `title`, capped at five and
// out of reach of a keyboard or a touch screen, so they sit in a menu
// the chip opens instead, with what each side did to them and the one
// sentence that clears them.
import { FolderOpen, RefreshCw } from "lucide-react";
import type { MirrorSession } from "@shared/ipc/modules/mirror";
import { ChipButton } from "@/components/ui/chip-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type StatusTone, TONE_TEXT } from "@/components/ui/status-dot";
import { pluralize } from "@/lib/pluralize";
import { notifyError } from "@/lib/toast";
import { cn } from "@/lib/utils";

type MirrorConflict = MirrorSession["conflicts"][number];

// A conflict is the root it happened at plus what each side did under
// it: one change for an ordinary edited file, a whole subtree when a
// directory was replaced. The kinds are what a person acts on, and the
// count says how wide the root goes.
function summarize(changes: MirrorConflict["localChanges"]): string {
  if (changes.length === 0) return "no change";
  const kinds = [...new Set(changes.map((change) => change.kind))].join(", ");
  if (changes.length === 1) return kinds;
  return `${kinds} (${pluralize(changes.length, "path")})`;
}

// Mutagen names a conflict root relative to the session's root, and
// the empty string means the worktree itself.
function conflictLabel(root: string): string {
  return root === "" ? "the whole worktree" : root;
}

function ConflictRow({
  conflict,
  reveal,
}: {
  conflict: MirrorConflict;
  reveal: ((root: string) => void) | null;
}) {
  const body = (
    <span className="flex min-w-0 flex-col gap-0.5 text-left">
      <span className="break-all text-foreground">
        {conflictLabel(conflict.root)}
      </span>
      <span className="text-muted-foreground">
        this device: {summarize(conflict.localChanges)}, other device:{" "}
        {summarize(conflict.remoteChanges)}
      </span>
    </span>
  );
  // Revealing is this machine's Finder, so it is offered only while
  // the session's own device is the one being viewed. Elsewhere the
  // row is text.
  if (reveal === null) {
    return <div className="px-2 py-1 text-xs">{body}</div>;
  }
  return (
    <DropdownMenuItem
      className="items-start"
      onClick={() => reveal(conflict.root)}
    >
      {body}
      <FolderOpen aria-hidden className="mt-0.5 ml-auto" />
    </DropdownMenuItem>
  );
}

// The conflict chip itself: the same shape as the read-only status
// chips in MirrorPill, as a button, because there is a list behind it.
export function MirrorConflictsChip({
  session,
  tone,
  label,
  canReveal,
}: {
  session: MirrorSession;
  tone: StatusTone;
  label: string;
  canReveal: boolean;
}) {
  const reveal = canReveal
    ? (root: string) => {
        const path =
          root === "" ? session.localRoot : `${session.localRoot}/${root}`;
        window.api.shell
          .showItemInFolder(path)
          .catch((err: unknown) =>
            notifyError("Couldn't reveal the path", err),
          );
      }
    : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <ChipButton
            className={cn("tabular shrink-0", TONE_TEXT[tone])}
            aria-label={`${label}: list the conflicting paths`}
          >
            <RefreshCw aria-hidden className="size-3.5" />
            {label}
          </ChipButton>
        }
      />
      <DropdownMenuContent align="start" className="max-w-sm min-w-64">
        <DropdownMenuLabel>
          {canReveal ? "Held still (click to reveal)" : "Held still"}
        </DropdownMenuLabel>
        {session.conflicts.map((conflict) => (
          <ConflictRow
            key={conflict.root}
            conflict={conflict}
            reveal={reveal}
          />
        ))}
        {session.excludedConflicts > 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {pluralize(session.excludedConflicts, "more conflict")} the engine
            did not list.
          </p>
        )}
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-xs text-muted-foreground">
          Both devices changed these since they last agreed, so the mirror
          leaves them alone. Make one side match the other, or put either side
          back to what it was before, and they start moving again.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
