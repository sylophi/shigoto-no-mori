import { useState } from "react";
import { SectionHeading } from "@/components/ui/section-heading";
import { useWorktreeData, useWorktreeDataWrite } from "@/hooks/useWorktreeData";
import type { Worktree } from "@shared/schemas";

export function NotesSection({ worktree }: { worktree: Worktree }) {
  // External worktrees deliberately have no on-disk state -- if shigomori
  // didn't create the worktree it doesn't own metadata for it.
  if (worktree.isExternal) return null;

  return <NotesSectionInner worktree={worktree} />;
}

function NotesSectionInner({ worktree }: { worktree: Worktree }) {
  const { data } = useWorktreeData(worktree.projectId, worktree.id);
  const write = useWorktreeDataWrite();

  const saved = data?.notes ?? "";
  const [draft, setDraft] = useState(saved);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);

  // Re-sync the draft when switching between worktrees or when the
  // data first loads. Tracking the worktree id lets us detect both.
  if (hydratedFor !== worktree.id) {
    setHydratedFor(worktree.id);
    setDraft(saved);
  }

  const commit = () => {
    const next = draft;
    if (next === saved) return;
    write.mutate({
      projectId: worktree.projectId,
      worktreeId: worktree.id,
      data: { notes: next.trim().length === 0 ? undefined : next },
    });
  };

  const status =
    write.isPending && draft !== saved
      ? "Saving…"
      : write.isSuccess && draft === saved
        ? "Saved"
        : "";

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading>Notes</SectionHeading>
        <span className="text-xs text-muted-foreground/60">{status}</span>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        rows={3}
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
      />
    </section>
  );
}
