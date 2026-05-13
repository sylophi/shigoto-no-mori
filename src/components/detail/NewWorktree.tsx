import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSelection } from "@/hooks/useSelection";
import { useProjects } from "@/hooks/useProjects";
import { useCreateWorktree } from "@/hooks/useWorktrees";

interface NewWorktreeProps {
  projectId: string;
}

export function NewWorktree({ projectId }: NewWorktreeProps) {
  const { clear, selectWorktree } = useSelection();
  const { data: projects = [] } = useProjects();
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

  const busy = create.isPending;
  const errorMessage = create.error ? create.error.message : null;

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
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground">{project.name}</span>
          <h1 className="text-lg font-medium tracking-tight">New worktree</h1>
        </div>
      </header>

      <div className="flex max-w-xl flex-col gap-6 px-8 py-6">
        <div className="space-y-2">
          <label
            htmlFor="branch-name"
            className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
          >
            New branch
          </label>
          <input
            id="branch-name"
            type="text"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            placeholder="feat/new-thing"
            disabled={busy}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm transition-colors outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:opacity-50"
          />
        </div>

        <div className="space-y-2">
          <label
            htmlFor="branch-base"
            className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
          >
            Branched from (optional)
          </label>
          <input
            id="branch-base"
            type="text"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder="main"
            disabled={busy}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm transition-colors outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:opacity-50"
          />
          <p className="text-xs text-muted-foreground">
            Defaults to the current HEAD. The worktree lives at{" "}
            <span className="font-mono">
              ~/shigomori/worktrees/{project.name}/&lt;branch&gt;
            </span>
            .
          </p>
        </div>

        {errorMessage && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {errorMessage}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button
            disabled={!branchName || busy}
            size="sm"
            onClick={handleCreate}
          >
            {busy ? "Creating…" : "Create worktree"}
          </Button>
          <Button variant="ghost" size="sm" onClick={clear} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
