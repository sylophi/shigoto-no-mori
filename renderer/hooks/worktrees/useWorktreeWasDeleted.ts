import { useState } from "react";
import type { Worktree } from "@shared/schemas";

export const WORKTREE_DELETED_MESSAGE = "This worktree was deleted.";

// True once the page's worktree has dropped out of the list after this
// mount saw it: deleted while open (here, on the device holding it,
// from the CLI). Its queries then fail as entity-gone, which the query
// client keeps quiet, so the page is what says so. A cold route to a
// missing id never saw it and stays "not found". Read it only past the
// list's pending and error guards, which both callers already have.
export function useWorktreeWasDeleted(
  worktreeId: string,
  worktree: Worktree | undefined,
): boolean {
  const [seenId, setSeenId] = useState(worktree?.id);
  if (worktree && worktree.id !== seenId) setSeenId(worktree.id);
  return !worktree && seenId === worktreeId;
}
