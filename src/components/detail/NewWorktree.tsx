import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSelection } from "@/hooks/useSelection";
import { useProjects } from "@/hooks/useProjects";

interface NewWorktreeProps {
  projectId: string;
}

export function NewWorktree({ projectId }: NewWorktreeProps) {
  const { clear } = useSelection();
  const { data: projects = [] } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const [branchName, setBranchName] = useState("");

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Project not found.
      </div>
    );
  }

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
            Branch name
          </label>
          <input
            id="branch-name"
            type="text"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            placeholder="feat/new-thing"
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm transition-colors outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
          />
          <p className="text-xs text-muted-foreground">
            Source picker, setup-script preview, and actual creation land in the
            next IPC commit.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button disabled={!branchName} size="sm">
            Create worktree
          </Button>
          <Button variant="ghost" size="sm" onClick={clear}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
