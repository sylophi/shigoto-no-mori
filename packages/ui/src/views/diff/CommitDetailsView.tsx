import type { ReactNode, Ref } from "react";
import {
  Check,
  Combine,
  Copy,
  Ellipsis,
  FolderGit2,
  GitBranchPlus,
  ListRestart,
  PencilLine,
  RotateCcw,
  TextCursorInput,
  Undo2,
} from "lucide-react";
import { Button } from "../../primitives/button.tsx";
import { useCopied } from "../../primitives/copy-button.tsx";
import { FOLD_FADE, ShowMoreButton } from "../../primitives/show-more.tsx";
import { cn } from "../../lib/utils.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../primitives/dropdown-menu.tsx";
import { pluralize } from "@shigomori/contracts/words";

// Under a commit's title on its page: the rest of its message, and what
// can be done with it, as buttons rather than a menu to find
// (CommitDetails.tsx says which moves it allows and runs them). A
// commit only the remote has says so, and only copies.
export function CommitDetailsView({
  hash,
  description,
  onlyOn,
  busy,
  canAmend,
  onAmend,
  canReword,
  onReword,
  canSquash,
  onSquash,
  undoCount,
  onUndo,
  canRevert,
  onRevert,
  pickTargets,
  onPick,
  canCommand,
  onNewWorktree,
  onHardReset,
  dialog,
}: {
  hash: string;
  // The message past its subject (CommitDescriptionView), once read.
  description: ReactNode;
  // The upstream, for a commit only it has.
  onlyOn: string | undefined;
  busy: boolean;
  canAmend: boolean;
  onAmend: () => void;
  canReword: boolean;
  onReword: () => void;
  canSquash: boolean;
  onSquash: () => void;
  // How many commits an undo takes, when one is allowed.
  undoCount: number | null;
  onUndo: () => void;
  canRevert: boolean;
  onRevert: () => void;
  // The worktrees it can be copied onto.
  pickTargets: readonly { id: string; branch: string; name: string }[];
  onPick: (worktreeId: string) => void;
  canCommand: boolean;
  onNewWorktree: () => void;
  onHardReset: () => void;
  // The reword or hard reset dialog, while it is open.
  dialog: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5 pt-1">
      {description}
      {onlyOn && (
        <p className="text-xs text-muted-foreground">
          Only on <span className="font-mono">{onlyOn}</span>, not on this
          branch yet.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {canAmend && (
          <Button variant="outline" size="xs" onClick={onAmend}>
            <PencilLine />
            Amend
          </Button>
        )}
        {/* HEAD's message is amended with the rest of it. */}
        {canReword && !canAmend && (
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={onReword}
          >
            <TextCursorInput />
            Reword
          </Button>
        )}
        {canSquash && (
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={onSquash}
          >
            <Combine />
            Squash
          </Button>
        )}
        {undoCount !== null && (
          <Button variant="outline" size="xs" disabled={busy} onClick={onUndo}>
            <Undo2 />
            {canAmend
              ? "Undo"
              : `Undo the ${pluralize(undoCount, "commit")} after it`}
          </Button>
        )}
        {!onlyOn && canRevert && (
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={onRevert}
          >
            <RotateCcw />
            Revert
          </Button>
        )}
        {pickTargets.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="xs" disabled={busy}>
                  <GitBranchPlus />
                  Copy to another worktree
                </Button>
              }
            />
            <DropdownMenuContent align="start" sideOffset={4}>
              {pickTargets.map((target) => (
                <DropdownMenuItem
                  key={target.id}
                  onClick={() => onPick(target.id)}
                >
                  <span className="font-mono">{target.branch}</span>
                  <span className="text-muted-foreground">{target.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {canCommand && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-xs" aria-label="More">
                  <Ellipsis />
                </Button>
              }
            />
            <DropdownMenuContent align="start" sideOffset={4}>
              <DropdownMenuItem disabled={busy} onClick={onNewWorktree}>
                <FolderGit2 />
                New worktree from here
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={busy}
                onClick={onHardReset}
              >
                <ListRestart />
                Hard reset to here…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <CopyHashButton hash={hash} />
      </div>
      {dialog}
    </div>
  );
}

// The rest of a commit's message. A long one starts cut down to a few
// lines, faded out at the cut, like a PR's body. Open, it scrolls past a
// share of the window, since the header it sits in stays put over the
// diff. CommitDetails measures whether it is cut down.
export function CommitDescriptionView({
  description,
  expanded,
  onToggle,
  truncated,
  bodyRef,
}: {
  description: string;
  expanded: boolean;
  onToggle: () => void;
  // The text runs past its few lines while folded.
  truncated: boolean;
  bodyRef?: Ref<HTMLParagraphElement>;
}) {
  return (
    <div className="flex flex-col items-start gap-1">
      <p
        ref={bodyRef}
        className={cn(
          "max-w-prose text-sm wrap-anywhere whitespace-pre-wrap text-muted-foreground select-text",
          expanded
            ? "max-h-[40vh] overflow-y-auto"
            : "max-h-[3lh] overflow-hidden",
          !expanded && truncated && FOLD_FADE,
        )}
      >
        {description}
      </p>
      {(expanded || truncated) && (
        <ShowMoreButton
          expanded={expanded}
          onToggle={onToggle}
          className="-mx-2"
        />
      )}
    </div>
  );
}

// The commit's hash at the row's far end, copied with a click.
function CopyHashButton({ hash }: { hash: string }) {
  const [copied, copy] = useCopied(hash);
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={copy}
      aria-label={`Copy hash ${hash}`}
      className="ml-auto text-muted-foreground"
    >
      <span className="font-mono">{hash}</span>
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
