// Header for remote worktrees whose project exists on no local
// checkout: ProjectRow's typography without its affordances (no
// collapse -- nothing persists it for a foreign project -- and no local
// actions). The group may span several devices sharing one repo
// identity; the per-row device markers below it tell those apart.
import { FolderGit2 } from "lucide-react";

interface RemoteProjectRowProps {
  name: string;
  count: number;
}

export function RemoteProjectRow({ name, count }: RemoteProjectRowProps) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground">
      <FolderGit2 className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{name}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground/70">
        {count}
      </span>
    </div>
  );
}
