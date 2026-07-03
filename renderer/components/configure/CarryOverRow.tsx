import { AlertTriangle, X } from "lucide-react";
import { MaterialIcon } from "@/components/ui/material-icon";
import { useFsStat } from "@/hooks/fs/useFsStat";
import { cn } from "@/lib/utils";
import type { CarryOverEntry } from "@shared/schemas";
import { ModePicker } from "./ModePicker";

interface CarryOverRowProps {
  entry: CarryOverEntry;
  projectPath: string;
  // .worktreeinclude already covers this path; the entry will be
  // auto-removed the next time a worktree is created.
  covered?: boolean;
  onChangeMode: (mode: CarryOverEntry["mode"]) => void;
  onRemove: () => void;
}

export function CarryOverRow({
  entry,
  projectPath,
  covered = false,
  onChangeMode,
  onRemove,
}: CarryOverRowProps) {
  const { data: stat, isLoading } = useFsStat(`${projectPath}/${entry.path}`);
  const missing = !isLoading && stat?.exists === false;
  const basename = entry.path.split("/").pop() ?? entry.path;
  return (
    <div className="group flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5">
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <MaterialIcon
          kind={stat?.isDirectory ? "folder" : "file"}
          name={basename}
          className="size-4"
        />
        <span
          className={cn(
            "min-w-0 truncate font-mono text-xs",
            missing && "text-destructive",
          )}
          title={entry.path}
        >
          {entry.path}
        </span>
        {missing && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
            title="Source no longer exists in the main checkout. New worktrees will skip this entry."
          >
            <AlertTriangle className="size-3" />
            missing
          </span>
        )}
        {covered && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
            title=".worktreeinclude now covers this path; this entry will be removed the next time a worktree is created."
          >
            covered
          </span>
        )}
      </span>
      <ModePicker mode={entry.mode} onChange={onChangeMode} />
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${entry.path}`}
        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
