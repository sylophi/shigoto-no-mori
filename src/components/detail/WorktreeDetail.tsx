import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { tildify } from "@/lib/projectPaths";
import { useConfirmTwice } from "@/hooks/useConfirmTwice";
import { useRuntimeInfo } from "@/hooks/useRuntimeInfo";
import { useDeleteWorktree } from "@/hooks/useWorktrees";
import { useSelection } from "@/hooks/useSelection";
import { LauncherRow } from "./LauncherRow";
import { ScriptsPanel } from "./ScriptsPanel";
import type { Worktree } from "@shared/types";

interface WorktreeDetailProps {
  worktree: Worktree;
  projectName: string;
}

function deleteButtonLabel(
  busy: boolean,
  armed: boolean,
  isDirty: boolean,
): string {
  if (busy) return "Deleting…";
  if (!armed) return "Delete worktree";
  return isDirty ? "Force delete?" : "Confirm delete?";
}

function deleteButtonTitle(armed: boolean, isDirty: boolean): string {
  if (!armed) return "Delete worktree";
  return isDirty
    ? "Click again to force-delete (dirty)"
    : "Click again to confirm delete";
}

export function WorktreeDetail({ worktree, projectName }: WorktreeDetailProps) {
  const { clear, beginConfigureProject } = useSelection();
  const { data: runtime } = useRuntimeInfo();
  const deleteMutation = useDeleteWorktree();
  const { armed: confirmDelete, trigger: confirmDeleteTrigger } =
    useConfirmTwice(3_000);
  const isDirty = worktree.dirtyCount > 0;
  const busy = deleteMutation.isPending;
  const home = runtime?.homedir ?? null;

  const handleDelete = () => {
    confirmDeleteTrigger(() => {
      deleteMutation.mutate(
        {
          projectId: worktree.projectId,
          worktreeId: worktree.id,
          force: isDirty,
        },
        { onSuccess: () => clear() },
      );
    });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-2 border-b border-border px-8 pt-7 pb-5">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => beginConfigureProject(worktree.projectId)}
            className="shrink-0 rounded transition-colors hover:text-foreground"
            title={`Configure ${projectName}`}
          >
            {projectName}
          </button>
          <span aria-hidden className="text-muted-foreground/40">
            /
          </span>
          <span className="min-w-0 truncate font-mono">
            {tildify(worktree.path, home)}
          </span>
        </div>
        <div className="flex items-start justify-between gap-4">
          <h1 className="min-w-0 truncate font-mono text-2xl font-medium tracking-tight">
            {worktree.branch}
          </h1>
          <StatusPills worktree={worktree} />
        </div>
      </header>

      <div className="overflow-y-auto px-8 py-6">
        <div className="flex max-w-4xl flex-col gap-8">
          <section>
            <SectionHeading>Launch</SectionHeading>
            <LauncherRow worktree={worktree} />
          </section>

          <Separator />

          <section className="space-y-3">
            <SectionHeading>Last commit</SectionHeading>
            {worktree.lastCommit ? (
              <div className="space-y-1">
                <div className="text-sm">{worktree.lastCommit.subject}</div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-mono">{worktree.lastCommit.hash}</span>
                  <span aria-hidden className="text-muted-foreground/40">
                    ·
                  </span>
                  <span>{worktree.lastCommit.author}</span>
                  <span aria-hidden className="text-muted-foreground/40">
                    ·
                  </span>
                  <RelativeDate date={worktree.lastCommit.date} />
                </div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                No commits yet.
              </div>
            )}
          </section>

          <Separator />

          <section className="space-y-3">
            <SectionHeading>Scripts</SectionHeading>
            <ScriptsPanel worktree={worktree} />
          </section>

          {deleteMutation.error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {deleteMutation.error.message}
            </div>
          )}
        </div>
      </div>

      <footer className="flex items-center gap-3 border-t border-border bg-card px-8 py-2.5">
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground select-text"
          title={worktree.path}
        >
          {tildify(worktree.path, home)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive",
            confirmDelete && "bg-destructive/10",
          )}
          disabled={busy}
          onClick={handleDelete}
          title={deleteButtonTitle(confirmDelete, isDirty)}
        >
          <Trash2 />
          {deleteButtonLabel(busy, confirmDelete, isDirty)}
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
  const pills: { label: string; tone: "neutral" | "warn" }[] = [];
  if (worktree.ahead > 0) {
    pills.push({ label: `↑ ${worktree.ahead}`, tone: "neutral" });
  }
  if (worktree.behind > 0) {
    pills.push({ label: `↓ ${worktree.behind}`, tone: "neutral" });
  }
  if (worktree.dirtyCount > 0) {
    pills.push({
      label: `${worktree.dirtyCount} dirty`,
      tone: "warn",
    });
  }
  if (pills.length === 0) {
    return (
      <span className="shrink-0 pt-1.5 text-xs text-muted-foreground/70">
        in sync
      </span>
    );
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 pt-1">
      {pills.map((pill) => (
        <span
          key={pill.label}
          className={cn(
            "tabular inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-xs",
            pill.tone === "neutral" &&
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
