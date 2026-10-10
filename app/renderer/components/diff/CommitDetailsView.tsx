import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Combine,
  Copy,
  Ellipsis,
  FolderGit2,
  GitBranchPlus,
  PencilLine,
  RotateCcw,
  TextCursorInput,
  Undo2,
} from "lucide-react";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { useCopied } from "@shigomori/ui/primitives/copy-button.tsx";
import { IconButton } from "@shigomori/ui/primitives/icon-button.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@shigomori/ui/primitives/dropdown-menu.tsx";
import { pluralize } from "@/lib/pluralize";

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
  dialog,
}: {
  hash: string;
  // The message past its subject, once read.
  description: string | undefined;
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
  // The reword dialog, while it is open.
  dialog: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5 pt-1">
      {description && (
        <p className="max-w-prose text-sm whitespace-pre-wrap text-muted-foreground select-text">
          {description}
        </p>
      )}
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
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <CopyHashButton hash={hash} />
      </div>
      {dialog}
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

// Beside a commit's view controls: a step to the commit after or before
// it on the branch's timeline, so a branch reads commit by commit.
export function CommitStepsView({
  onNewer,
  onOlder,
}: {
  // Unset at that end of the timeline.
  onNewer: (() => void) | undefined;
  onOlder: (() => void) | undefined;
}) {
  return (
    <div className="flex items-center">
      <SimpleTooltip tip="Newer commit">
        <IconButton
          aria-label="Newer commit"
          disabled={!onNewer}
          onClick={onNewer}
        >
          <ArrowUp aria-hidden className="size-4" />
        </IconButton>
      </SimpleTooltip>
      <SimpleTooltip tip="Older commit">
        <IconButton
          aria-label="Older commit"
          disabled={!onOlder}
          onClick={onOlder}
        >
          <ArrowDown aria-hidden className="size-4" />
        </IconButton>
      </SimpleTooltip>
    </div>
  );
}
