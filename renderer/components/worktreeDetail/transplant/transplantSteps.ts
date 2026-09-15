// The transplant dialog's reading of the pull's progress frames: which
// named step is running (the core four, plus the files step when the
// leave-out rule admits something), with everything before it done and
// everything after it queued, and a single overall figure for the bar
// between the two devices.
import { useEffect, useState } from "react";
import {
  type SyncPullProgress,
  type SyncPullStep,
  SyncPullStepSchema,
} from "@shared/ipc/modules/sync";
import type { CreatePhase } from "@shared/schemas";

export const PULL_STEPS = SyncPullStepSchema.options;
// The files step is the optional one, and the last: a pull with
// nothing to bring stops at the apply.
export function pullStepCount(bringsFiles: boolean): number {
  return bringsFiles ? PULL_STEPS.length : PULL_STEPS.indexOf("files");
}

// Before the first frame the orchestrator is negotiating tips, which
// is the capture step's preamble, so the first step reads as running
// from the start.
export function currentStepIndex(frame: SyncPullProgress | null): number {
  return PULL_STEPS.indexOf(frame?.step ?? "capture");
}

const CREATE_PHASE_SHARE: Record<CreatePhase, number> = {
  carryOver: 0.3,
  setup: 0.55,
  portPoolProvision: 0.8,
};

// 0..1 across the whole pull. The transfer owns the widest band since
// it is the only step with a real measure. The others advance by
// arrival.
export function overallProgress(frame: SyncPullProgress | null): number {
  if (frame === null) return 0.04;
  switch (frame.step) {
    case "capture":
      return 0.08;
    case "transfer": {
      const total = frame.totalBytes ?? 0;
      const ratio = total > 0 ? Math.min(1, (frame.bytes ?? 0) / total) : 0;
      return 0.12 + ratio * 0.48;
    }
    case "create":
      return (
        0.62 +
        (frame.createPhase ? CREATE_PHASE_SHARE[frame.createPhase] : 0) * 0.28
      );
    case "apply":
      return 0.93;
    case "files": {
      const total = frame.totalBytes ?? 0;
      const ratio = total > 0 ? Math.min(1, (frame.bytes ?? 0) / total) : 0;
      return 0.94 + ratio * 0.05;
    }
  }
}

// A once-a-second tick while a pull runs, for the elapsed figure.
// Frozen (and free) otherwise.
export function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// The running headline under the dialog title, one per step, phrased
// against the two device names.
export function stepHeadline(
  step: SyncPullStep,
  sourceDeviceLabel: string,
): string {
  switch (step) {
    case "capture":
      return `capturing the uncommitted work on ${sourceDeviceLabel}`;
    case "transfer":
      return "sending the branch and changes over the device link";
    case "create":
      return "creating the worktree here";
    case "apply":
      return "re-applying your changes here";
    case "files":
      return `bringing the ignored files over from ${sourceDeviceLabel}`;
  }
}
