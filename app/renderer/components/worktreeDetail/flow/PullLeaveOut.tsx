// A pull dialog's leave-out step (transplant or mirror): the picker
// over the source worktree, and under it the way to keep the rule on
// screen as the project's preset, so the next pull of the repo, on any
// device, opens on it. The row stays out of the way while the two
// agree.
import { Bookmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PullChoiceState } from "./ignoreChoice";
import { browseWorktree, LeaveOutPicker } from "./LeaveOutPicker";

export function PullLeaveOut({
  pull,
  worktree,
}: {
  pull: PullChoiceState;
  // The source worktree, under the source's scope.
  worktree: { projectId: string; id: string; path: string };
}) {
  return (
    <LeaveOutPicker
      value={pull.selection}
      onChange={pull.setSelection}
      ignored={pull.ignored}
      browse={browseWorktree(worktree)}
    >
      {pull.presetDiffers && (
        <Button
          variant="ghost"
          size="sm"
          title="Start from this rule whenever you mirror or transplant this project's worktrees, on any device. You can change it under Configure."
          onClick={pull.saveAsPreset}
        >
          <Bookmark />
          Save as project default
        </Button>
      )}
    </LeaveOutPicker>
  );
}
