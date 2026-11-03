import { useLayoutEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { commitMessageQueryOptions } from "@/hooks/worktrees/useWorktreeChanges";
import {
  commitDraftOf,
  isEmptyDraft,
  setCommitDraft,
} from "@/store/commitDraft";
import type { CommitDraft } from "@shigomori/ui/views/diff/CommitComposerView.tsx";

// What amend mode does to the composer's draft. On the way in, the
// commit's own message is loaded into an empty draft (a draft with text
// in it is left alone). On the way out, whatever was there before comes
// back. Done once the message arrives, so it behaves the same whether
// amend mode was entered from the strip's button or from a commit row's
// menu, and before paint, so the box never shows empty in between.
//
// Returns a reset for after the amend lands, when there is nothing to
// put back.
export function useAmendDraft({
  projectId,
  worktreeId,
  amending,
  hash,
}: {
  projectId: string;
  worktreeId: string;
  amending: boolean;
  // The commit being amended. Only read while `amending`.
  hash: string | undefined;
}): () => void {
  const scope = useHostScope();
  const { deviceId } = scope;
  const { data: message } = useQuery({
    ...commitMessageQueryOptions(scope, projectId, worktreeId, hash ?? ""),
    enabled: amending && hash !== undefined,
  });
  // The draft that was in the box before amend mode replaced it, keyed
  // by the commit so a HEAD that changes underneath seeds again.
  const parked = useRef<{ hash: string; draft: CommitDraft } | null>(null);

  useLayoutEffect(() => {
    const ref = { deviceId, projectId, worktreeId };
    if (amending && hash && message && parked.current?.hash !== hash) {
      const draft = commitDraftOf(ref);
      parked.current = { hash, draft };
      if (isEmptyDraft(draft)) setCommitDraft(ref, message);
    } else if (!amending && parked.current) {
      setCommitDraft(ref, parked.current.draft);
      parked.current = null;
    }
  }, [deviceId, projectId, worktreeId, amending, hash, message]);

  return () => {
    parked.current = null;
  };
}
