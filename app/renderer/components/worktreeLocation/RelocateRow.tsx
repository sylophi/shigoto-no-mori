import { WorktreeMoveDetails } from "@/components/shared/WorktreeMoveDetails";
import { type RowStatus } from "@/components/ui/row-status";
import { cn } from "@/lib/utils";
import { tildify } from "@/lib/projectPaths";
import type { Worktree } from "@shared/schemas";

interface RelocateRowProps {
  worktree: Worktree;
  destination: string;
  status: RowStatus;
  home: string | null;
}

export function RelocateRow({
  worktree,
  destination,
  status,
  home,
}: RelocateRowProps) {
  const fromPath = tildify(worktree.path, home);
  const toPath = tildify(destination, home);
  return (
    <div className={cn("flex items-start gap-3 px-3 py-3 text-sm")}>
      <WorktreeMoveDetails
        branch={worktree.branch}
        detached={worktree.detached}
        fromPath={fromPath}
        fromTitle={worktree.path}
        toPath={toPath}
        toTitle={destination}
        status={status}
        labels={{ running: "Moving", done: "Moved", error: "Move failed" }}
      />
    </div>
  );
}
