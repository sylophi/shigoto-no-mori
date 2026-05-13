import { TreeDeciduous } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { useProjects } from "@/hooks/useProjects";

export function EmptyState() {
  const { data: projects = [] } = useProjects();
  const { openIn } = useCommandPalette();
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
      <Button size="sm" onClick={() => openIn("add-project")}>
        {hasProjects ? "Add another project" : "Add your first project"}
      </Button>
    </div>
  );
}
