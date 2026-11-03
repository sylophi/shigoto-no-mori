// The changes page's commit message, per worktree and kept across
// launches. The composer edits it, a landed commit empties it, amend
// mode (useAmendDraft) swaps it out and back, and an undo can fill it.
import type { CommitDraft } from "@shigomori/ui/views/diff/CommitComposerView.tsx";
import {
  createWorktreeStore,
  useWorktreeStore,
  type WorktreeRef,
} from "./worktreeState";

export const EMPTY_DRAFT: CommitDraft = { summary: "", description: "" };

export function isEmptyDraft(draft: CommitDraft): boolean {
  return !draft.summary && !draft.description;
}

// Every empty draft is EMPTY_DRAFT, which the store keeps out of storage.
const held = (draft: CommitDraft): CommitDraft =>
  isEmptyDraft(draft) ? EMPTY_DRAFT : draft;

const drafts = createWorktreeStore<CommitDraft>({
  empty: EMPTY_DRAFT,
  persist: {
    key: ({ deviceId, projectId, worktreeId }) =>
      `commit.draft.${deviceId}.${projectId}.${worktreeId}`,
    parse: ({ summary, description }) =>
      held({
        summary: typeof summary === "string" ? summary : "",
        description: typeof description === "string" ? description : "",
      }),
  },
  moves: true,
});

export const useCommitDraft = (ref: WorktreeRef): CommitDraft =>
  useWorktreeStore(drafts, ref);

// The draft as it is now, outside a render.
export const commitDraftOf = (ref: WorktreeRef): CommitDraft => drafts.get(ref);

export function setCommitDraft(ref: WorktreeRef, draft: CommitDraft): void {
  drafts.update(ref, () => held(draft));
}

// Put `draft` in the box from outside the page, but only while it is
// empty, so a message being written is never lost to it. An undone
// commit's message comes back this way.
export function fillEmptyCommitDraft(
  ref: WorktreeRef,
  draft: CommitDraft,
): void {
  drafts.update(ref, (current) =>
    isEmptyDraft(current) ? held(draft) : current,
  );
}
