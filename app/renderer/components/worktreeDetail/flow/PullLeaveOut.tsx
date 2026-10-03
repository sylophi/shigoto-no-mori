// A pull dialog's leave-out step (transplant or mirror): the picker
// over the source worktree, and under it the way to keep the rule on
// screen as the project's preset, so the next pull of the repo, on any
// device, opens on it. The row stays out of the way while the two
// agree.
import type { PullChoiceState } from "./ignoreChoice";
import { browseWorktree, LeaveOutPicker } from "./LeaveOutPicker";
import { SaveAsPresetButton } from "./PullLeaveOutView";

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
      {pull.presetDiffers && <SaveAsPresetButton onClick={pull.saveAsPreset} />}
    </LeaveOutPicker>
  );
}
