import { useQuery } from "@tanstack/react-query";
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
import { Button } from "@/components/ui/button";
import { useCopied } from "@/components/ui/copy-button";
import { IconButton } from "@/components/ui/icon-button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { commitMessageQueryOptions } from "@/hooks/worktrees/useWorktreeChanges";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { CommitRewrite } from "@/lib/commitRewrite";
import { pluralize } from "@/lib/pluralize";
import type { CommitSummary, Worktree } from "@shigomori/contracts/schemas";
import { useCommitActions } from "@/components/worktreeDetail/git/useCommitActions";

// Under a commit's title on its page: the rest of its message, and what
// can be done with it, as buttons rather than a menu to find. The moves
// that rewrite it only show while no remote has it. A commit only the
// remote has (its side of a split) says so, and only copies, as does
// every commit on a peer that takes no commands from here.
export function CommitDetails({
  worktree,
  commit,
  index,
  rewrite,
  onlyOn,
}: {
  worktree: Worktree;
  commit: CommitSummary;
  // Where it sits on HEAD's line, newest first.
  index: number;
  rewrite: CommitRewrite;
  // The upstream, for a commit only it has.
  onlyOn?: string;
}) {
  const nav = useWorktreeNav();
  const scope = useHostScope();
  const { data: message } = useQuery(
    commitMessageQueryOptions(
      scope,
      worktree.projectId,
      worktree.id,
      commit.hash,
    ),
  );
  // A rewrite gives this commit a new hash at the same place on the
  // line (a squash folds it into the one below, which takes its place),
  // so the page follows it there, or to the head past the row's reach.
  const actions = useCommitActions(worktree, (rewritten) => {
    const next =
      rewritten.recentCommits[index]?.hash ?? rewritten.recentCommits[0]?.hash;
    if (next) nav.toCommit(worktree.projectId, worktree.id, next, true);
  });
  const { canAmend, undo, reword, squash } = rewrite;
  const busy = actions.pending;

  return (
    <div className="flex flex-col gap-2.5 pt-1">
      {message?.description && (
        <p className="max-w-prose text-sm whitespace-pre-wrap text-muted-foreground select-text">
          {message.description}
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
          <Button
            variant="outline"
            size="xs"
            onClick={() =>
              nav.toDiff(worktree.projectId, worktree.id, { amend: true })
            }
          >
            <PencilLine />
            Amend
          </Button>
        )}
        {/* HEAD's message is amended with the rest of it. */}
        {reword && !canAmend && (
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => actions.reword(commit, reword.head)}
          >
            <TextCursorInput />
            Reword
          </Button>
        )}
        {squash && (
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => actions.squash(commit, squash.head)}
          >
            <Combine />
            Squash
          </Button>
        )}
        {undo && (
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => actions.undoTo(undo)}
          >
            <Undo2 />
            {canAmend
              ? "Undo"
              : `Undo the ${pluralize(undo.count, "commit")} after it`}
          </Button>
        )}
        {!onlyOn && actions.canRevert && (
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => actions.revert(commit)}
          >
            <RotateCcw />
            Revert
          </Button>
        )}
        {actions.pickTargets.length > 0 && (
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
              {actions.pickTargets.map((target) => (
                <DropdownMenuItem
                  key={target.id}
                  onClick={() => actions.cherryPickInto(target, commit)}
                >
                  <span className="font-mono">{target.branch}</span>
                  <span className="text-muted-foreground">{target.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {actions.canCommand && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-xs" aria-label="More">
                  <Ellipsis />
                </Button>
              }
            />
            <DropdownMenuContent align="start" sideOffset={4}>
              <DropdownMenuItem
                disabled={busy}
                onClick={() => actions.newWorktreeFrom(commit)}
              >
                <FolderGit2 />
                New worktree from here
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <CopyHashButton hash={commit.hash} />
      </div>
      {actions.dialog}
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
export function CommitSteps({
  worktree,
  newer,
  older,
}: {
  worktree: Worktree;
  newer: string | undefined;
  older: string | undefined;
}) {
  const nav = useWorktreeNav();
  const step = (hash: string | undefined) =>
    hash && nav.toCommit(worktree.projectId, worktree.id, hash, true);
  return (
    <div className="flex items-center">
      <SimpleTooltip tip="Newer commit">
        <IconButton
          aria-label="Newer commit"
          disabled={!newer}
          onClick={() => step(newer)}
        >
          <ArrowUp aria-hidden className="size-4" />
        </IconButton>
      </SimpleTooltip>
      <SimpleTooltip tip="Older commit">
        <IconButton
          aria-label="Older commit"
          disabled={!older}
          onClick={() => step(older)}
        >
          <ArrowDown aria-hidden className="size-4" />
        </IconButton>
      </SimpleTooltip>
    </div>
  );
}
