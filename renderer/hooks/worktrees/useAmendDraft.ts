import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { commitMessageQueryOptions } from "@/hooks/worktrees/useWorktreeChanges";
import type { CommitDraft } from "@/lib/commitDraft";

// What amend mode does to the composer's draft. On the way in, the
// commit's own message is loaded into an empty draft (a draft with text
// in it is left alone). On the way out, whatever was there before comes
// back. Done during render once the message arrives, the same way
// DiffView resets its fold state, so it behaves the same whether amend
// mode was entered from the strip's button or from a commit row's menu.
//
// Returns a reset for after the amend lands, when there is nothing to
// put back.
export function useAmendDraft({
  projectId,
  worktreeId,
  amending,
  hash,
  draft,
  setDraft,
}: {
  projectId: string;
  worktreeId: string;
  amending: boolean;
  // The commit being amended. Only read while `amending`.
  hash: string | undefined;
  draft: CommitDraft;
  setDraft: (draft: CommitDraft) => void;
}): () => void {
  const { data: message } = useQuery({
    ...commitMessageQueryOptions(projectId, worktreeId, hash ?? ""),
    enabled: amending && hash !== undefined,
  });
  // The draft that was in the box before amend mode replaced it, keyed
  // by the commit so a HEAD that changes underneath seeds again.
  const [parked, setParked] = useState<{
    hash: string;
    draft: CommitDraft;
  } | null>(null);

  if (amending && hash && message && parked?.hash !== hash) {
    setParked({ hash, draft });
    if (!draft.summary && !draft.description) setDraft(message);
  } else if (!amending && parked) {
    setParked(null);
    setDraft(parked.draft);
  }

  return () => setParked(null);
}
