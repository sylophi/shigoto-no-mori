import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { SectionHeading } from "@/components/ui/section-heading";
import { useBranches } from "@/hooks/git/useBranches";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { useScopedProjectParams } from "@/hooks/projects/useProjectNav";
import { useProjects } from "@/hooks/projects/useProjects";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { isRealBranch, type Worktree } from "@shared/schemas";
import { BranchRow } from "./BranchRow";
import { NewBranchForm } from "./NewBranchForm";

export function ManageBranches() {
  const { projectId } = useScopedProjectParams();
  const { data: projects = [] } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const { data: branches } = useBranches(projectId);
  const { data: worktrees = [] } = useWorktrees(projectId);
  const { data: defaultBranch } = useDefaultBranch(projectId);
  const [creating, setCreating] = useState(false);

  if (!project) {
    return <CenteredMessage>Project not found.</CenteredMessage>;
  }

  const worktreeByBranch = new Map<string, Worktree>();
  for (const w of worktrees) {
    if (isRealBranch(w.branch)) worktreeByBranch.set(w.branch, w);
  }

  const locals = branches?.local ?? [];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 pt-7 pb-4">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-muted-foreground">
            {project.name}
          </span>
          <h1 className="text-lg font-medium tracking-tight">
            Manage branches
          </h1>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="flex max-w-3xl flex-col gap-10">
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <SectionHeading>Local branches</SectionHeading>
              {!creating && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setCreating(true)}
                >
                  <Plus />
                  New branch
                </Button>
              )}
            </div>

            {creating && (
              <NewBranchForm
                projectId={projectId}
                defaultBase={defaultBranch ?? null}
                onDone={() => setCreating(false)}
              />
            )}

            {locals.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No local branches yet.
              </p>
            ) : (
              <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
                {locals.map((name) => (
                  <BranchRow
                    key={name}
                    projectId={projectId}
                    name={name}
                    worktree={worktreeByBranch.get(name)}
                  />
                ))}
              </div>
            )}
          </section>

          {(branches?.remote ?? []).length > 0 && (
            <section className="space-y-3">
              <SectionHeading>Remote-tracking branches</SectionHeading>
              <p className="text-xs text-muted-foreground">
                Read-only references. Use one as a source when creating a new
                local branch.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(branches?.remote ?? []).map((name) => (
                  <span
                    key={name}
                    className="rounded-md bg-muted/60 px-2 py-1 font-mono text-xs text-muted-foreground select-text"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
