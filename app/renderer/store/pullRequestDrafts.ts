// The create pull request dialog's unsent form, per device, worktree and
// branch, so closing the dialog (or leaving the worktree) and opening it
// again finds the form as it was left, its attachments still staged on
// the host. This window's, kept for the session, and dropped once the PR
// is made. A field still null was never touched and shows what the
// dialog seeds it with.
import { useSyncExternalStore } from "react";
import { createExternalStore } from "@shigomori/ui/lib/externalStore.ts";
import type { Attachment } from "@shigomori/ui/lib/pullRequestAttachments.ts";

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

const drafts = createExternalStore<ReadonlyMap<string, PullRequestDraftForm>>(
  new Map(),
);

// By branch too: a worktree that checks out another one starts another
// PR.
export function pullRequestDraftKey(
  deviceId: string,
  worktreeId: string,
  branch: string,
) {
  return `${deviceId}:${worktreeId}:${branch}`;
}

export function usePullRequestDraftForm(key: string): PullRequestDraftForm {
  const read = () => pullRequestDraftForm(key);
  return useSyncExternalStore(drafts.subscribe, read, read);
}

// The form as it is now, outside a render.
export function pullRequestDraftForm(key: string): PullRequestDraftForm {
  return drafts.get().get(key) ?? EMPTY;
}

// Applies to the form as it is now, so an upload finishing after the
// dialog was closed still lands on it.
export function patchPullRequestDraft(
  key: string,
  patch: (form: PullRequestDraftForm) => Partial<PullRequestDraftForm>,
): void {
  const current = pullRequestDraftForm(key);
  const next = new Map(drafts.get());
  next.set(key, { ...current, ...patch(current) });
  drafts.publish(next);
}

export function dropPullRequestDraft(key: string): void {
  const next = new Map(drafts.get());
  next.delete(key);
  drafts.publish(next);
}

// Every branch's form, for a worktree that is gone.
export function forgetPullRequestDrafts(
  deviceId: string,
  worktreeId: string,
): void {
  const prefix = pullRequestDraftKey(deviceId, worktreeId, "");
  const next = new Map(drafts.get());
  for (const key of next.keys()) if (key.startsWith(prefix)) next.delete(key);
  if (next.size !== drafts.get().size) drafts.publish(next);
}
