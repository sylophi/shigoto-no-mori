import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { TreeDeciduous } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { modKey, shiftKey } from "@/lib/platform";
import { useCommandPalette } from "@/hooks/ui/useCommandPalette";
import { useProjects } from "@/hooks/projects/useProjects";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";

export function EmptyState() {
  const { data: projects = [], isLoading: projectsLoading } = useProjects();
  const { openIn } = useCommandPalette();
  const navigate = useNavigate();
  const worktreeQueries = useAllProjectWorktrees(projects);

  // Walk projects in order so we redirect to the first worktree the user
  // would see in the sidebar. Wait on in-flight queries for an earlier
  // project rather than skipping past it -- otherwise a slow first project
  // would lose its turn to a later one.
  let redirectProjectId: string | null = null;
  let redirectWorktreeId: string | null = null;
  let waitingForQuery = false;
  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    if (!project || project.pathExists === false) continue;
    const query = worktreeQueries[i];
    if (!query) continue;
    if (query.isLoading) {
      waitingForQuery = true;
      break;
    }
    const first = (query.data ?? [])[0];
    if (first) {
      redirectProjectId = project.id;
      redirectWorktreeId = first.id;
      break;
    }
  }

  useEffect(() => {
    if (!redirectProjectId || !redirectWorktreeId) return;
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId",
      params: {
        projectId: redirectProjectId,
        worktreeId: redirectWorktreeId,
      },
      replace: true,
    });
  }, [redirectProjectId, redirectWorktreeId, navigate]);

  if (projectsLoading) return null;
  if (projects.length === 0) {
    return <FirstRun onAdd={() => openIn("add-project")} />;
  }
  // Suppress BetweenWorktrees while a redirect is pending or still resolvable.
  if (redirectProjectId || waitingForQuery) return null;
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
            <Mono>~/shigomori/worktrees/</Mono>.
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
              <Kbd>{modKey}</Kbd>
              <Kbd>{shiftKey}</Kbd>
              <Kbd>P</Kbd>
            </KbdGroup>{" "}
            for the palette
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
          Pick a worktree from the sidebar, or press{" "}
          <KbdGroup className="mx-0.5 inline-flex">
            <Kbd>{modKey}</Kbd>
            <Kbd>{shiftKey}</Kbd>
            <Kbd>P</Kbd>
          </KbdGroup>{" "}
          to jump.
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
      <span className="tabular mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-card text-[11px] font-medium text-muted-foreground">
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
    <span className="rounded bg-muted px-1 py-px font-mono text-[12px]">
      {children}
    </span>
  );
}
