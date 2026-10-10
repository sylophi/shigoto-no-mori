import { useQuery } from "@tanstack/react-query";

import { useHostScope } from "@/hooks/remote/useHostScope";
import { commitMessageQueryOptions } from "@/hooks/worktrees/useWorktreeChanges";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { CommitRewrite } from "@shigomori/ui/views/worktreeDetail/git/commitRewrite.ts";
import type { CommitSummary, Worktree } from "@shigomori/contracts/schemas";
import { useCommitActions } from "@/components/worktreeDetail/git/useCommitActions";
import {
  CommitDetailsView,
  CommitStepsView,
} from "@shigomori/ui/views/diff/CommitDetailsView.tsx";

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
    <CommitDetailsView
      hash={commit.hash}
      description={message?.description}
      onlyOn={onlyOn}
      busy={busy}
      canAmend={canAmend}
      onAmend={() =>
        nav.toDiff(worktree.projectId, worktree.id, { amend: true })
      }
      canReword={reword !== null}
      onReword={() => reword && actions.reword(commit, reword.head)}
      canSquash={squash !== null}
      onSquash={() => squash && actions.squash(commit, squash.head)}
      undoCount={undo?.count ?? null}
      onUndo={() => undo && actions.undoTo(undo)}
      canRevert={actions.canRevert}
      onRevert={() => actions.revert(commit)}
      pickTargets={actions.pickTargets}
      onPick={(id) => {
        const target = actions.pickTargets.find((t) => t.id === id);
        if (target) actions.cherryPickInto(target, commit);
      }}
      canCommand={actions.canCommand}
      onNewWorktree={() => actions.newWorktreeFrom(commit)}
      dialog={actions.dialog}
    />
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
    <CommitStepsView
      onNewer={newer ? () => step(newer) : undefined}
      onOlder={older ? () => step(older) : undefined}
    />
  );
}
