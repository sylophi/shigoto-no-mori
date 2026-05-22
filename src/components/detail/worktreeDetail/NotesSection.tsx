import { useState } from "react";
import { SectionHeading } from "@/components/ui/section-heading";
import { useDefaultBranch } from "@/hooks/useDefaultBranch";
import { useShigomoriConfig } from "@/hooks/useShigomoriConfig";
import { useShigomoriWrite } from "@/hooks/useShigomoriWrite";
import type { Worktree } from "@shared/schemas";

export function NotesSection({ worktree }: { worktree: Worktree }) {
  const { data: config } = useShigomoriConfig(worktree.projectId);
  const { data: resolvedDefaultBranch } = useDefaultBranch(worktree.projectId);
  const write = useShigomoriWrite();

  const saved = config?.notes?.[worktree.id] ?? "";
  const [draft, setDraft] = useState(saved);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);

  // Re-sync the draft when switching between worktrees or when the
  // config first loads. Tracking the worktree id lets us detect both.
  if (hydratedFor !== worktree.id) {
    setHydratedFor(worktree.id);
    setDraft(saved);
  }

  const commit = () => {
    const next = draft;
    if (next === saved) return;
    if (!resolvedDefaultBranch && !config?.defaultBranch) return;
    const base = config ?? {
      defaultBranch: resolvedDefaultBranch ?? "main",
    };
    const nextNotes = { ...config?.notes };
    if (next.trim().length === 0) {
      delete nextNotes[worktree.id];
    } else {
      nextNotes[worktree.id] = next;
    }
    write.mutate({
      projectId: worktree.projectId,
      config: {
        ...base,
        notes: Object.keys(nextNotes).length > 0 ? nextNotes : undefined,
      },
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
