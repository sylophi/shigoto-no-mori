import { useEffect, useState } from "react";
import { readStoredJson, removeStored, writeStored } from "@/lib/localStorage";

// The commit message being written for a worktree, persisted so leaving
// the changes page (to check one more file in the editor, say) doesn't
// cost it. Keyed per worktree: two branches in flight have two drafts.
export interface CommitDraft {
  summary: string;
  description: string;
}

export const EMPTY_DRAFT: CommitDraft = { summary: "", description: "" };

function draftKey(projectId: string, worktreeId: string): string {
  return `commit.draft.${projectId}.${worktreeId}`;
}

function readCommitDraft(projectId: string, worktreeId: string): CommitDraft {
  const stored = readStoredJson<Partial<CommitDraft>>(
    draftKey(projectId, worktreeId),
    {},
  );
  return {
    summary: typeof stored.summary === "string" ? stored.summary : "",
    description:
      typeof stored.description === "string" ? stored.description : "",
  };
}

export function clearCommitDraft(projectId: string, worktreeId: string): void {
  removeStored(draftKey(projectId, worktreeId));
}

// The open changes pages, told which draft was filled under them.
const listeners = new Set<(key: string) => void>();

// Put `draft` in the box from outside the page, but only while it is
// empty, so a message being written is never lost to it. An undone
// commit's message comes back this way.
export function fillEmptyCommitDraft(
  projectId: string,
  worktreeId: string,
  draft: CommitDraft,
): void {
  const current = readCommitDraft(projectId, worktreeId);
  if (current.summary || current.description) return;
  const key = draftKey(projectId, worktreeId);
  writeStored(key, JSON.stringify(draft));
  for (const listener of listeners) listener(key);
}

// The draft as state plus its persistence, owned by the changes page:
// the composer edits it, a landed commit empties it, amend mode
// (useAmendDraft) swaps it out and back, and an undo
// (fillEmptyCommitDraft) can fill it. Persisted from an effect rather
// than in the setter, so amend mode can seed it during render without a
// storage write in the middle of one.
export function useCommitDraft(projectId: string, worktreeId: string) {
  const [draft, setDraft] = useState<CommitDraft>(() =>
    readCommitDraft(projectId, worktreeId),
  );
  useEffect(() => {
    if (draft.summary || draft.description) {
      writeStored(draftKey(projectId, worktreeId), JSON.stringify(draft));
    } else {
      clearCommitDraft(projectId, worktreeId);
    }
  }, [draft, projectId, worktreeId]);
  useEffect(() => {
    const key = draftKey(projectId, worktreeId);
    const onFill = (filled: string) => {
      if (filled === key) setDraft(readCommitDraft(projectId, worktreeId));
    };
    listeners.add(onFill);
    return () => {
      listeners.delete(onFill);
    };
  }, [projectId, worktreeId]);
  return [draft, setDraft] as const;
}
