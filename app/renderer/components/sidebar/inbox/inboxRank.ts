import { type Worktree, worktreeLastActivityAt } from "@shared/schemas";

// Where a worktree ranks within one of the inbox's boxes: one whose
// agent waits on you comes first while its mark shows (pinWaiting, the
// Mark worktrees whose agent needs you setting), the longest wait
// first, then the newest work, with the name as the tiebreak so
// worktrees with no activity at all (fresh, never committed, clean)
// still land in a stable order.
export interface InboxRank {
  worktree: Worktree;
  activityAt: number;
  // When its longest waiting agent started waiting on you, if one is
  // and pinWaiting.
  waitingAt: number | undefined;
}

export function inboxRank(worktree: Worktree, pinWaiting: boolean): InboxRank {
  return {
    worktree,
    activityAt: worktreeLastActivityAt(worktree),
    waitingAt: pinWaiting ? longestWaitAt(worktree) : undefined,
  };
}

function longestWaitAt(worktree: Worktree): number | undefined {
  const waits = (worktree.agentSessions ?? [])
    .filter((s) => s.state === "waiting")
    .map((s) => s.at);
  return waits.length > 0 ? Math.min(...waits) : undefined;
}

export function byInboxRank(a: InboxRank, b: InboxRank): number {
  if (a.waitingAt !== undefined || b.waitingAt !== undefined) {
    if (a.waitingAt === undefined) return 1;
    if (b.waitingAt === undefined) return -1;
    if (a.waitingAt !== b.waitingAt) return a.waitingAt - b.waitingAt;
  }
  const diff = b.activityAt - a.activityAt;
  return diff !== 0 ? diff : a.worktree.name.localeCompare(b.worktree.name);
}
