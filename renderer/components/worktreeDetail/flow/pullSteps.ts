// The pull dialogs' reading of the pull's progress frames: where the
// run stands among its steps (the pull's own, with the create spelled
// out as its lifecycle phases), what state each listed step is in, the
// headline for the step underway, and a single overall figure for the
// bar between the two devices.
import { useEffect, useState } from "react";
import {
  type SyncPullProgress,
  type SyncPullStep,
  SyncPullStepSchema,
} from "@shared/ipc/modules/sync";
import { type CreatePhase, CreatePhaseSchema } from "@shared/schemas";

// The run as one ordered line: the pull's steps, with the create's
// lifecycle phases slotted in right after the create itself. Both
// orders are the schemas' own. A row or a frame sits at its index
// here, and whatever follows the pull (a mirror's session open) sits
// past the end.
type TimelineStop = SyncPullStep | CreatePhase;
const createAt = SyncPullStepSchema.literals.indexOf("create") + 1;
const TIMELINE: TimelineStop[] = [
  ...SyncPullStepSchema.literals.slice(0, createAt),
  ...CreatePhaseSchema.literals,
  ...SyncPullStepSchema.literals.slice(createAt),
];
export function stepPosition(stop: TimelineStop): number {
  return TIMELINE.indexOf(stop);
}
export const AFTER_PULL_POSITION = TIMELINE.length;

// Before the first frame the orchestrator is negotiating tips, which
// is the capture step's preamble, so the first step reads as running
// from the start.
export function framePosition(frame: SyncPullProgress | null): number {
  return stepPosition(frame?.createPhase ?? frame?.step ?? "capture");
}

// Each row's state against the frame, for rows in run order. The
// running row is the last one the run takes at or before the frame, so
// a phase with no row of its own (ports the review did not foresee, a
// carry-over that only reports a broken include file) reads as the row
// before it still running. A skipped row never runs: the host passes
// through its frame without doing the work (the apply on a clean
// tree), so the run is already on the next row it takes, or past the
// last one.
export type StepState = "done" | "running" | "queued" | "skipped";
const taken = (row: { skipped?: boolean }) => !row.skipped;
export function stepStates(
  rows: readonly { position: number; skipped?: boolean }[],
  at: number,
): StepState[] {
  const onSkipped = rows.some((row) => row.skipped && row.position === at);
  const next = rows.findIndex((row) => taken(row) && row.position > at);
  const running = onSkipped
    ? next === -1
      ? rows.length
      : next
    : rows.findLastIndex((row) => taken(row) && row.position <= at);
  return rows.map((row, index) =>
    row.skipped
      ? "skipped"
      : index > running
        ? "queued"
        : index === running
          ? "running"
          : "done",
  );
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

// Where a flow lands, as the words for it: this machine (the pulls), or
// a peer (a transplant or a mirror to it), where "here" would name the
// wrong machine. Made once per dialog and handed down, so every piece
// of the flow says the same place the same way.
export type Landing = {
  onPeer: boolean;
  // Standing alone: "Open here", "ignored files there".
  here: "here" | "there";
  // In a sentence: "creating the worktree here / on Thinkpad".
  on: string;
  // As a direction: "Transplanted feat here / to Thinkpad".
  to: string;
};
export const LANDS_HERE: Landing = {
  onPeer: false,
  here: "here",
  on: "here",
  to: "here",
};
export function landsOnPeer(label: string): Landing {
  return { onPeer: true, here: "there", on: `on ${label}`, to: `to ${label}` };
}

// The running headline under the dialog title, one per step (and per
// lifecycle phase of the create), phrased against the source's name
// and the landing.
export function stepHeadline(
  frame: SyncPullProgress | null,
  sourceDeviceLabel: string,
  landing: Landing = LANDS_HERE,
): string {
  const here = landing.on;
  switch (frame?.step ?? "capture") {
    case "capture":
      return `capturing the uncommitted work on ${sourceDeviceLabel}`;
    case "transfer":
      return "sending the branch and changes over the device link";
    case "create":
      switch (frame?.createPhase) {
        case "carryOver":
          return "carrying files over into the new worktree";
        case "setup":
          return `running the setup script ${here}`;
        case "portPoolProvision":
          return "provisioning ports for the new worktree";
        default:
          return `creating the worktree ${here}`;
      }
    case "apply":
      return `re-applying your changes ${here}`;
    case "files":
      return landing.onPeer
        ? `sending the ignored files over ${landing.to}`
        : `bringing the ignored files over from ${sourceDeviceLabel}`;
  }
}
