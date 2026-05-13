import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSelection } from "@/hooks/useSelection";
import { useProjects } from "@/hooks/useProjects";
import { useRuntimeInfo } from "@/hooks/useRuntimeInfo";
import { useCreateWorktree } from "@/hooks/useWorktrees";
import { tildify } from "@/lib/projectPaths";
import { sanitizeBranchForPath } from "@shared/branches";

interface NewWorktreeProps {
  projectId: string;
}

export function NewWorktree({ projectId }: NewWorktreeProps) {
  const { clear, selectWorktree } = useSelection();
  const { data: projects = [] } = useProjects();
  const { data: runtime } = useRuntimeInfo();
  const project = projects.find((p) => p.id === projectId);
  const [branchName, setBranchName] = useState("");
  const [base, setBase] = useState("");
  const create = useCreateWorktree();

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Project not found.
      </div>
    );
  }

  const handleCreate = () => {
    create.mutate(
      { projectId: project.id, branchName, base: base || undefined },
      {
        onSuccess: (worktree) => {
          selectWorktree(worktree.id);
        },
      },
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (branchName.length > 0 && !create.isPending) {
      handleCreate();
    }
  };

  const busy = create.isPending;
  const errorMessage = create.error ? create.error.message : null;
  const home = runtime?.homedir ?? null;
  const root = runtime?.shigomoriRoot
    ? tildify(runtime.shigomoriRoot, home)
    : "~/shigomori";
  const sanitized = branchName ? sanitizeBranchForPath(branchName) : "";
  const destination = sanitized
    ? `${root}/worktrees/${project.name}/${sanitized}`
    : null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-8 py-4">
        <button
          type="button"
          onClick={clear}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Back"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-muted-foreground">
            {project.name}
          </span>
          <h1 className="text-lg font-medium tracking-tight">New worktree</h1>
        </div>
      </header>

      <form
        className="flex max-w-xl flex-col gap-7 px-8 py-6"
        onSubmit={handleSubmit}
      >
        <div className="space-y-2">
          <label htmlFor="branch-name" className="block text-sm font-medium">
            Branch name
          </label>
          <input
            id="branch-name"
            type="text"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            placeholder="feat/new-thing"
            disabled={busy}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- first field of a focused subpage
            autoFocus
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm transition-colors outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:opacity-50"
          />
          <div className="text-xs text-muted-foreground">
            {destination ? (
              <>
                Worktree will live at{" "}
                <span className="font-mono text-foreground/80">
                  {destination}
                </span>
              </>
            ) : (
              <>
                A new branch on this repo, checked out into its own folder under{" "}
                <span className="font-mono">{root}/worktrees/</span>.
              </>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <label htmlFor="branch-base" className="block text-sm font-medium">
            Branched from{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
          </label>
          <input
            id="branch-base"
            type="text"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder="HEAD"
            disabled={busy}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm transition-colors outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:opacity-50"
          />
          <p className="text-xs text-muted-foreground">
            Defaults to the current HEAD of the primary checkout. Accepts any
            ref: a branch, tag, or commit.
          </p>
        </div>

        {errorMessage && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {errorMessage}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={!branchName || busy} size="sm">
            {busy ? "Creating…" : "Create worktree"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clear}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
