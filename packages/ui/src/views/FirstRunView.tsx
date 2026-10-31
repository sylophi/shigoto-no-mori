// The home with no project, a fresh install's first screen: an
// orientation, the way to the first project, and what it leads to.
import type { ReactNode } from "react";
import { TreeDeciduous } from "lucide-react";
import { Button } from "../primitives/button.tsx";
import { Kbd } from "../primitives/kbd.tsx";

export function FirstRunView({
  worktreesDir,
  addKeys,
  onAdd,
}: {
  // Where this device's worktrees live, tildified, null until the
  // app's data folder is known.
  worktreesDir: string | null;
  // Add a project's keys (lib/keymap.ts), none in a window without them.
  addKeys: string | null;
  onAdd: () => void;
}) {
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
          Shigoto no Mori manages parallel git worktrees. One project is a repo.
          One worktree is a branch checked out into its own folder, launchable
          in your editor with one click.
        </p>
        <ol className="mb-8 space-y-4 text-sm">
          <StepView n={1} title="Add a project.">
            Point to a folder with a <MonoView>.git</MonoView>, or scan a parent
            folder for many at once.
          </StepView>
          <StepView n={2} title="Spawn worktrees.">
            One per branch you want in parallel. They live under{" "}
            {worktreesDir === null ? (
              "the app's data folder"
            ) : (
              <MonoView>{worktreesDir}</MonoView>
            )}
            .
          </StepView>
          <StepView n={3} title="Launch your tools.">
            Open each worktree in Cursor, VS Code, Zed, or any custom tool you
            wire up in the project's Configure page.
          </StepView>
        </ol>
        <div className="flex items-center gap-4">
          <Button size="sm" onClick={onAdd}>
            Add a project
          </Button>
          {addKeys !== null && (
            <span className="text-xs text-muted-foreground">
              or <Kbd className="mx-0.5">{addKeys}</Kbd> from anywhere
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function StepView({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
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

function MonoView({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-muted px-1 py-px font-mono text-xs">
      {children}
    </span>
  );
}
