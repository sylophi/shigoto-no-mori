// The home with no project to show (every one removed since the first
// run): the way to the next, and what it leads to.
import { Button } from "../primitives/button.tsx";

export function FirstRunView({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
      <Button size="sm" onClick={onAdd}>
        Add a project
      </Button>
      <p>
        A forest, eventually.
        <br />
        Each project is a repo, each worktree a branch in its own folder.
      </p>
    </div>
  );
}
