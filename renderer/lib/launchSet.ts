// Fires a launch set: the same `launchers:launch` IPC the row's pills
// use, once per member. Lives in lib rather than a hook because both the
// Launch row and the auto-launch-on-create listener (which runs outside
// React) need it.
import { toast } from "@/lib/toast";
import type { LaunchSet } from "@shared/schemas";

export interface LaunchSetInput {
  projectId: string;
  worktreeId: string;
  set: LaunchSet;
  // Display name for a member id, used only in the failure toast. Falls
  // back to the raw id when the row can't resolve it -- which is exactly
  // the case a failure report is most likely to be about.
  labelFor?: (launcherId: string) => string | undefined;
}

interface LaunchSetFailure {
  launcherId: string;
  reason: string;
}

export interface LaunchSetResult {
  launched: number;
  failures: LaunchSetFailure[];
}

// How many failure lines the toast spells out before summarizing the
// rest. Matches the carry-over report's clipping.
const MAX_REPORTED = 4;

// Members launch one at a time, in order: the order is the point (editor
// first, agent last) and three concurrent spawns fight over the
// foreground window. A failure never stops the rest -- a missing agent
// CLI shouldn't cost you the editor.
//
// Errors are collected rather than thrown, because the natural failure
// mode here is plural: a set built on a laptop with three apps installed
// hits a machine with none and would otherwise stack three toasts. One
// summary covers them, keyed per set + worktree so re-running replaces
// the old notice instead of piling on.
export async function runLaunchSet(
  input: LaunchSetInput,
): Promise<LaunchSetResult> {
  const { projectId, worktreeId, set } = input;
  const failures: LaunchSetFailure[] = [];

  for (const launcherId of set.launcherIds) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential is the feature: the configured order is what the user asked for, and Promise.all would race three apps for the foreground
      await window.api.launchers.launch({ projectId, worktreeId, launcherId });
    } catch (err) {
      failures.push({
        launcherId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const result = {
    launched: set.launcherIds.length - failures.length,
    failures,
  };
  if (failures.length > 0) reportFailures(input, result);
  return result;
}

function reportFailures(input: LaunchSetInput, result: LaunchSetResult): void {
  const { set, worktreeId } = input;
  const shown = result.failures.slice(0, MAX_REPORTED);
  const more = result.failures.length - shown.length;
  const description =
    shown
      .map(
        (f) => `${input.labelFor?.(f.launcherId) ?? f.launcherId}: ${f.reason}`,
      )
      .join("\n") + (more > 0 ? `\n...and ${more} more` : "");
  const options = { id: `launch-set:${set.id}:${worktreeId}`, description };

  if (result.launched === 0) {
    toast.error(`Couldn't launch ${set.label}`, options);
    return;
  }
  toast.warning(
    `Launched ${result.launched} of ${set.launcherIds.length} in ${set.label}`,
    options,
  );
}
