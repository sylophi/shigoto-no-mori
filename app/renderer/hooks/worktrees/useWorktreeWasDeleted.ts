import { useState } from "react";
import type { Worktree } from "@shigomori/contracts/schemas";

// True once a worktree page's worktree has dropped out of the list
// after this mount saw it: deleted while open (here, on the device
// holding it, from the CLI). The detail page leaves on it. A sub-page's
// queries then fail as entity-gone, which the query client keeps
// quiet, so the sub-page is what says so. A cold route to a missing id
// never saw it and stays "not found". Read it only past the list's
// pending and error guards, which WorktreeMissingView already has.
export function useWorktreeWasDeleted(
  worktreeId: string,
  worktree: Worktree | undefined,
): boolean {
  const [seenId, setSeenId] = useState(worktree?.id);
  if (worktree && worktree.id !== seenId) setSeenId(worktree.id);
  return !worktree && seenId === worktreeId;
}
