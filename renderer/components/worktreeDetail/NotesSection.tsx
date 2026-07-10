import { useState } from "react";
import { SectionHeading } from "@/components/ui/section-heading";
import { Textarea } from "@/components/ui/textarea";
import {
  useWorktreeData,
  useWorktreeDataWrite,
} from "@/hooks/worktrees/useWorktreeData";
import type { Worktree } from "@shared/schemas";

export function NotesSection({ worktree }: { worktree: Worktree }) {
  // The primary checkout (the main repo root) lives at the project path,
  // which never sits under a managed prefix, so it's flagged external --
  // but it's ours to annotate, so notes stay available for it. Only
  // genuinely external worktrees (manual checkouts elsewhere) are skipped.
  if (worktree.isExternal && !worktree.isPrimary) return null;
  return <NotesSectionLoader key={worktree.id} worktree={worktree} />;
}

function NotesSectionLoader({ worktree }: { worktree: Worktree }) {
  const { data, isPending } = useWorktreeData(worktree.projectId, worktree.id);
  // Wait for the persisted value before mounting the editor. The inner
  // seeds its draft from `saved` via useState, which only reads the
  // initial value -- mounting while the read is still in flight would
  // seed an empty draft that never picks up the notes once they arrive.
  if (isPending) return null;
  return <NotesSectionInner worktree={worktree} saved={data?.notes ?? ""} />;
}

function NotesSectionInner({
  worktree,
  saved,
}: {
  worktree: Worktree;
  saved: string;
}) {
  const write = useWorktreeDataWrite();

  const [draft, setDraft] = useState(saved);

  const commit = () => {
    const next = draft;
    if (next === saved) return;
    write.mutate({
      projectId: worktree.projectId,
      worktreeId: worktree.id,
      data: { notes: next.trim().length === 0 ? undefined : next },
    });
  };

  // Compare against what the last write actually sent, not `saved` --
  // the prop lags behind until the invalidation refetch lands, which
  // would blank the status right after a successful save.
  const submitted = write.variables?.data.notes ?? "";
  const status = write.isPending
    ? "Saving…"
    : write.isSuccess && draft === submitted
      ? "Saved"
      : "";

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading>Notes</SectionHeading>
        <span className="text-xs text-muted-foreground/60">{status}</span>
      </div>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        rows={3}
        className="w-full resize-y px-3 py-2 text-sm"
      />
    </section>
  );
}
