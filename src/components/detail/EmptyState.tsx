import { TreeDeciduous } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAddProjectFlow, useProjects } from "@/hooks/useProjects";

export function EmptyState() {
  const { data: projects = [] } = useProjects();
  const addProject = useAddProjectFlow();
  const hasProjects = projects.length > 0;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div className="flex size-12 items-center justify-center rounded-2xl border border-border bg-card text-muted-foreground">
        <TreeDeciduous className="size-5" />
      </div>
      <div className="max-w-sm space-y-2 text-center">
        <h1 className="text-lg font-medium tracking-tight">
          {hasProjects ? "Pick a worktree to begin" : "A forest, eventually"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {hasProjects
            ? "Select a worktree from the sidebar, or add another project."
            : "Add a project to start managing its worktrees."}
        </p>
      </div>
      <Button size="sm" onClick={() => void addProject.start()}>
        {hasProjects ? "Add another project" : "Add your first project"}
      </Button>
      {addProject.error && (
        <button
          type="button"
          onClick={() => addProject.reset()}
          className="max-w-sm rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive hover:bg-destructive/15"
          title="Click to dismiss"
        >
          {addProject.error.message}
        </button>
      )}
    </div>
  );
}
