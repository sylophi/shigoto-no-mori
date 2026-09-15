// Step 2 of the transplant: both devices on screen with the pull's
// progress between them, and the named steps (the core four, plus the
// files step when a leave-out rule admits something) with done /
// running / queued states read off the orchestrator's frames, so a
// stall is attributable to one step. Also the failed view: the same list,
// frozen where it stopped, with the error and a retry.
import { AlertCircle, Check, Laptop, Monitor } from "lucide-react";
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import type { SyncPullProgress } from "@shared/ipc/modules/sync";
import { errorMessageOf } from "@shared/errors";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { formatBytes } from "@/lib/formatBytes";
import { cn } from "@/lib/utils";
import { CREATE_PHASE_LABEL } from "@/store/worktreeLifecycle";
import { TransplantBody, TransplantFooter } from "./TransplantChrome";
import {
  currentStepIndex,
  overallProgress,
  PULL_STEPS,
} from "./transplantSteps";

// The pull's core steps, before the optional files step: the row a
// mirror's extra rows start at once the apply frame has landed.
const CORE_ROW_COUNT = PULL_STEPS.indexOf("files");
const NO_EXTRA_ROWS: { title: string; detail: string }[] = [];

type StepState = "done" | "running" | "queued";

export function TransplantProgress({
  frame,
  sourceDeviceLabel,
  thisDeviceLabel,
  dirty,
  error,
  onClose,
  onRetry,
  extraRows = NO_EXTRA_ROWS,
  filesDetail,
  sourcePart = "source, untouched",
  runningNote = `Keep this window open. Nothing on ${sourceDeviceLabel} changes until step 3.`,
  failedNote = `The copy on ${sourceDeviceLabel} is untouched. If the worktree already landed here, open it from the sidebar instead of retrying.`,
  progressLabel = "Transplant progress",
}: {
  frame: SyncPullProgress | null;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
  dirty: boolean;
  // Set on the failed view. Refusals toast centrally, so they get a
  // one-line stand-in here instead of the raw marker.
  error?: unknown;
  onClose: () => void;
  onRetry: () => void;
  // Steps after the pull's core four (the mirror's session open),
  // running once the apply frame has landed. The mutation settling
  // ends the view, so a row here never reads as done.
  extraRows?: { title: string; detail: string }[];
  // The transplant's files step (the ignored files the leave-out rule
  // admits), as its row's caption. Absent on a mirror: its own session
  // carries the files.
  filesDetail?: string;
  sourcePart?: string;
  runningNote?: string;
  failedNote?: string;
  progressLabel?: string;
}) {
  const failed = error !== undefined;
  const pullDone = frame?.step === "apply" && extraRows.length > 0;
  const current = pullDone ? CORE_ROW_COUNT : currentStepIndex(frame);
  const ratio = pullDone ? 0.97 : overallProgress(frame);
  const caption = (step: "transfer" | "files") =>
    frame?.step === step && frame.totalBytes
      ? `${formatBytes(frame.bytes ?? 0)} of ${formatBytes(frame.totalBytes)}`
      : null;
  const transferCaption = caption("transfer");
  const filesCaption = caption("files");

  const rows: { title: string; detail: string }[] = [
    {
      title: `Capture on ${sourceDeviceLabel}`,
      detail: dirty ? "uncommitted changes" : "clean tree",
    },
    {
      title: "Transfer over the device link",
      detail: transferCaption ?? "one git bundle",
    },
    {
      title: `Create the worktree on ${thisDeviceLabel}`,
      detail:
        frame?.step === "create" && frame.createPhase
          ? CREATE_PHASE_LABEL[frame.createPhase]
          : "carry-over, setup, ports",
    },
    {
      title: "Re-apply your changes",
      detail: dirty ? "uncommitted, staging kept" : "skipped",
    },
    ...(filesDetail === undefined
      ? []
      : [
          {
            title: "Bring the ignored files over",
            detail: filesCaption ?? filesDetail,
          },
        ]),
    ...extraRows,
  ];

  return (
    <>
      <TransplantBody>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <DeviceEnd
              icon={<Monitor aria-hidden className="size-4" />}
              name={sourceDeviceLabel}
              part={sourcePart}
            />
            <div className="min-w-0 flex-1 space-y-1.5">
              <p className="h-4 truncate text-center text-xs text-sky-700 dark:text-sky-300">
                {failed ? "stopped" : (transferCaption ?? filesCaption ?? " ")}
              </p>
              <div
                role="progressbar"
                aria-label={progressLabel}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(ratio * 100)}
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className={cn(
                    "h-full rounded-full transition-[width] duration-500 ease-out",
                    failed ? "bg-rose-500" : "bg-sky-500",
                  )}
                  style={{ width: `${Math.round(ratio * 100)}%` }}
                />
              </div>
            </div>
            <DeviceEnd
              icon={<Laptop aria-hidden className="size-4" />}
              name={thisDeviceLabel}
              part="destination"
              align="end"
            />
          </div>

          <ol className="space-y-1">
            {rows.map((row, index) => (
              <StepRow
                key={row.title}
                state={
                  index < current
                    ? "done"
                    : index === current
                      ? "running"
                      : "queued"
                }
                failed={failed}
                title={row.title}
                detail={row.detail}
              />
            ))}
          </ol>

          {failed && (
            <ErrorBanner>
              {isCommandRefusedError(error)
                ? peerReadOnlyNote(sourceDeviceLabel)
                : errorMessageOf(error)}
            </ErrorBanner>
          )}
        </div>
      </TransplantBody>

      {failed ? (
        <TransplantFooter note={failedNote}>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        </TransplantFooter>
      ) : (
        <TransplantFooter note={runningNote} />
      )}
    </>
  );
}

function DeviceEnd({
  icon,
  name,
  part,
  align = "start",
}: {
  icon: React.ReactNode;
  name: string;
  part: string;
  align?: "start" | "end";
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2",
        align === "end" && "flex-row-reverse text-right",
      )}
    >
      <span className="text-muted-foreground">{icon}</span>
      <div className="leading-tight">
        <p className="text-sm font-medium">{name}</p>
        <p className="text-[11px] text-muted-foreground">{part}</p>
      </div>
    </div>
  );
}

function StepRow({
  state,
  failed,
  title,
  detail,
}: {
  state: StepState;
  failed: boolean;
  title: string;
  detail: string;
}) {
  const stopped = failed && state === "running";
  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm",
        state === "running" && !failed && "bg-sky-500/10",
        stopped && "bg-rose-500/10",
        state === "queued" && "text-muted-foreground",
      )}
    >
      <StepMark state={state} stopped={stopped} />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{title}</span>
        <span className="ml-2 text-xs text-muted-foreground">{detail}</span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {stopped ? "stopped" : state}
      </span>
    </li>
  );
}

function StepMark({ state, stopped }: { state: StepState; stopped: boolean }) {
  if (stopped || state === "done") {
    return (
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full text-background",
          stopped ? "bg-rose-500" : "bg-emerald-500",
        )}
      >
        {stopped ? (
          <AlertCircle className="size-2.5" />
        ) : (
          <Check className="size-2.5" />
        )}
      </span>
    );
  }
  if (state === "running") {
    return (
      <span aria-hidden className="relative flex size-4 shrink-0">
        <span className="absolute inset-0 animate-ping rounded-full bg-sky-500/40" />
        <span className="relative m-auto size-2.5 rounded-full bg-sky-500" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="size-4 shrink-0 rounded-full bg-muted-foreground/20"
    />
  );
}
