import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  FolderOpen,
  GitMerge,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useDeleteWorktree } from "@/hooks/useWorktrees";
import { useSelection } from "@/hooks/useSelection";
import type { Worktree } from "@shared/types";

interface WorktreeDetailProps {
  worktree: Worktree;
  projectName: string;
}

export function WorktreeDetail({ worktree, projectName }: WorktreeDetailProps) {
  const { clear } = useSelection();
  const deleteMutation = useDeleteWorktree();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isDirty = worktree.dirtyCount > 0;
  const busy = deleteMutation.isPending;

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      window.setTimeout(() => setConfirmDelete(false), 3_000);
      return;
    }
    deleteMutation.mutate(
      {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        force: isDirty,
      },
      {
        onSuccess: () => clear(),
      },
    );
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-8 py-6">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{projectName}</span>
          <span aria-hidden>·</span>
          <span className="font-mono">{worktree.path}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <h1 className="font-mono text-2xl font-medium tracking-tight">
            {worktree.branch}
          </h1>
          <StatusPills worktree={worktree} />
        </div>
      </header>

      <div className="flex flex-col gap-8 overflow-y-auto px-8 py-6">
        <section>
          <SectionHeading>Launch</SectionHeading>
          <div className="text-sm text-muted-foreground">
            T3-style preferred-app button + chevron menu lands in the next
            commit.
          </div>
        </section>

        <Separator />

        <section className="space-y-3">
          <SectionHeading>Last commit</SectionHeading>
          {worktree.lastCommit ? (
            <div className="space-y-1">
              <div className="font-mono text-sm">
                {worktree.lastCommit.subject}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">{worktree.lastCommit.hash}</span>
                <span aria-hidden>·</span>
                <span>{worktree.lastCommit.author}</span>
                <span aria-hidden>·</span>
                <RelativeDate date={worktree.lastCommit.date} />
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No commits yet.</div>
          )}
        </section>

        <Separator />

        <section className="space-y-3">
          <SectionHeading>Scripts</SectionHeading>
          <div className="text-sm text-muted-foreground">
            setup / run / teardown scripts panel lands when `shigoto.json` IPC
            is wired.
          </div>
        </section>

        {deleteMutation.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {deleteMutation.error.message}
          </div>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-border bg-card px-8 py-3">
        <Button variant="ghost" size="sm">
          <ArrowDownToLine />
          Pull
        </Button>
        <Button variant="ghost" size="sm">
          <ArrowUpFromLine />
          Push
        </Button>
        <Button variant="ghost" size="sm">
          <GitMerge />
          Merge to main
        </Button>
        <Button variant="ghost" size="sm">
          <FolderOpen />
          Reveal in Finder
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "text-destructive hover:bg-destructive/10 hover:text-destructive",
            confirmDelete && "bg-destructive/10",
          )}
          disabled={worktree.isPrimary || busy}
          onClick={handleDelete}
          title={
            worktree.isPrimary
              ? "Primary worktree can't be deleted from here"
              : confirmDelete
                ? isDirty
                  ? "Click again to force-delete (dirty)"
                  : "Click again to confirm delete"
                : "Delete worktree"
          }
        >
          <Trash2 />
          {busy
            ? "Deleting…"
            : confirmDelete
              ? isDirty
                ? "Force delete?"
                : "Confirm delete?"
              : "Delete worktree"}
        </Button>
      </footer>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </h2>
  );
}

function StatusPills({ worktree }: { worktree: Worktree }) {
  const pills: { label: string; tone: "muted" | "warn" | "ok" }[] = [];
  if (worktree.status === "clean") {
    pills.push({ label: "clean", tone: "ok" });
  }
  if (worktree.ahead > 0) {
    pills.push({ label: `↑${worktree.ahead} ahead`, tone: "muted" });
  }
  if (worktree.behind > 0) {
    pills.push({ label: `↓${worktree.behind} behind`, tone: "muted" });
  }
  if (worktree.dirtyCount > 0) {
    pills.push({
      label: `${worktree.dirtyCount} dirty`,
      tone: "warn",
    });
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {pills.map((pill) => (
        <span
          key={pill.label}
          className={cn(
            "tabular rounded-md border px-1.5 py-0.5 text-xs",
            pill.tone === "ok" && "border-border bg-card text-muted-foreground",
            pill.tone === "muted" &&
              "border-border bg-card text-muted-foreground",
            pill.tone === "warn" &&
              "border-destructive/30 bg-destructive/10 text-destructive",
          )}
        >
          {pill.label}
        </span>
      ))}
    </div>
  );
}

function RelativeDate({ date }: { date: string }) {
  const value = new Date(date);
  const diffMs = Date.now() - value.getTime();
  const diffHours = Math.max(0, Math.round(diffMs / (1000 * 60 * 60)));
  const label =
    diffHours < 1
      ? "just now"
      : diffHours < 24
        ? `${diffHours}h ago`
        : `${Math.round(diffHours / 24)}d ago`;
  return <span title={value.toLocaleString()}>{label}</span>;
}
