import { TreeDeciduous } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { useProjects } from "@/hooks/projects/useProjects";

// "/" and a fresh window land here, waiting for a pick. No worktree
// opens on its own, since the sidebar would follow it into its project
// (openProject.ts) and skip the list of projects.
export function EmptyState() {
  const { data: projects = [], isLoading: projectsLoading } = useProjects();
  const { openAddProject } = useOverlays();

  if (projectsLoading) return null;
  if (projects.length === 0) {
    return <FirstRun onAdd={() => openAddProject()} />;
  }
  return <BetweenWorktrees />;
}

function FirstRun({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-md">
        <div className="mb-7 flex items-center gap-3">
          <TreeDeciduous className="size-6 text-muted-foreground/70" />
          <h1 className="text-xl font-medium tracking-tight">
            A forest, eventually.
          </h1>
        </div>
        <p className="mb-8 text-sm leading-relaxed text-muted-foreground">
          Shigoto no Mori manages parallel git worktrees. One project is a repo;
          one worktree is a branch checked out into its own folder, launchable
          in your editor with one click.
        </p>
        <ol className="mb-8 space-y-4 text-sm">
          <Step n={1} title="Add a project.">
            Point to a folder with a <Mono>.git</Mono>, or scan a parent folder
            for many at once.
          </Step>
          <Step n={2} title="Spawn worktrees.">
            One per branch you want in parallel. They live under{" "}
            <Mono>~/.sm/worktrees/</Mono>.
          </Step>
          <Step n={3} title="Launch your tools.">
            Open each worktree in Cursor, VS Code, Zed, or any custom tool you
            wire up in the project's Configure page.
          </Step>
        </ol>
        <div className="flex items-center gap-4">
          <Button size="sm" onClick={onAdd}>
            Add a project
          </Button>
          <span className="text-xs text-muted-foreground">
            or{" "}
            <KbdGroup className="mx-0.5 inline-flex">
              <Kbd>⌘</Kbd>
              <Kbd>N</Kbd>
            </KbdGroup>{" "}
            from anywhere
          </span>
        </div>
      </div>
    </div>
  );
}

function BetweenWorktrees() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-sm space-y-3 text-center">
        <p className="text-sm text-muted-foreground">Nothing selected.</p>
        <p className="text-xs text-muted-foreground/70">
          Pick from the sidebar, or press{" "}
          <KbdGroup className="mx-0.5 inline-flex">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>{" "}
          to search every worktree.
        </p>
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="tabular mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-card text-2xs font-medium text-muted-foreground">
        {n}
      </span>
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        <div className="text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-muted px-1 py-px font-mono text-xs">
      {children}
    </span>
  );
}
