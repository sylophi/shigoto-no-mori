import { TreeDeciduous } from "lucide-react";
import { Button } from "@/components/ui/button";

export function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div className="flex size-12 items-center justify-center rounded-2xl border border-border bg-card text-muted-foreground">
        <TreeDeciduous className="size-5" />
      </div>
      <div className="max-w-sm space-y-2 text-center">
        <h1 className="text-lg font-medium tracking-tight">
          A forest, eventually
        </h1>
        <p className="text-sm text-muted-foreground">
          Add a project to start managing its worktrees. Or pick one from the
          sidebar.
        </p>
      </div>
      <Button size="sm">Add your first project</Button>
    </div>
  );
}
