// The create pull request dialog's unsent form, per worktree and
// branch, so closing the dialog (or leaving the worktree) and opening it
// again finds the form as it was left, its attachments still staged on
// the host. This window's, kept for the session, and dropped once the PR
// is made. A field still null was never touched and shows what the
// dialog seeds it with.
import type { Attachment } from "@shigomori/ui/lib/pullRequestAttachments.ts";
import {
  createWorktreeStore,
  useWorktreeStore,
  type WorktreeRef,
} from "./worktreeState";

export interface PullRequestDraftForm {
  base: string | null;
  title: string | null;
  body: string | null;
  reviewers: string[];
  assignees: string[];
  labels: string[];
  attachments: Attachment[];
}

const EMPTY: PullRequestDraftForm = {
  base: null,
  title: null,
  body: null,
  reviewers: [],
  assignees: [],
  labels: [],
  attachments: [],
};

// By branch: a worktree that checks out another one starts another PR.
const drafts = createWorktreeStore<ReadonlyMap<string, PullRequestDraftForm>>({
  empty: new Map(),
  moves: true,
});

export function usePullRequestDraftForm(
  ref: WorktreeRef,
  branch: string,
): PullRequestDraftForm {
  return useWorktreeStore(drafts, ref).get(branch) ?? EMPTY;
}

// The form as it is now, outside a render.
export function pullRequestDraftForm(
  ref: WorktreeRef,
  branch: string,
): PullRequestDraftForm {
  return drafts.get(ref).get(branch) ?? EMPTY;
}

// Applies to the form as it is now, so an upload finishing after the
// dialog was closed still lands on it.
export function patchPullRequestDraft(
  ref: WorktreeRef,
  branch: string,
  patch: (form: PullRequestDraftForm) => Partial<PullRequestDraftForm>,
): void {
  drafts.update(ref, (forms) => {
    const current = forms.get(branch) ?? EMPTY;
    return new Map(forms).set(branch, { ...current, ...patch(current) });
  });
}

export function dropPullRequestDraft(ref: WorktreeRef, branch: string): void {
  drafts.update(ref, (forms) => {
    const next = new Map(forms);
    next.delete(branch);
    return next;
  });
}
