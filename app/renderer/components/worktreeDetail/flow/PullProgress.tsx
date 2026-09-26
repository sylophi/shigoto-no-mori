// Step 2 of the transplant: both devices on screen with the pull's
// progress between them, and the run as named steps read off the
// orchestrator's frames, so a stall is attributable to one step. The
// create is spelled out as the phases this project actually has
// (carry-over, the setup script by its command, ports), and a step
// the run leaves out (setup switched off, a clean tree) is listed as
// skipped rather than dropped. Also the failed view: the same list,
// frozen where it stopped, with the error and a retry. And the
// cancelled view, the same list frozen the same way, with what the
// cancel left (nothing landed) in place of an error.
import { AlertCircle, Ban, Check, type LucideIcon, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import type { DeviceIcon } from "@shared/account/deviceIcon";
import type { SyncPullProgress } from "@shared/ipc/modules/sync";
import type { CreatePhase, Worktree } from "@shared/schemas";
import { errorMessageOf } from "@shared/errors";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { DeviceGlyph } from "@/components/shared/DeviceGlyph";
import {
  DestinationScope,
  useDestinationScope,
  useHostScope,
} from "@/hooks/remote/useHostScope";
import { useDeviceIcon } from "@/hooks/remote/useRemoteDevices";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { formatBytes } from "@/lib/formatBytes";
import { pluralize } from "@/lib/pluralize";
import { pullLandingBranch, pullWorktreeName } from "@shared/git/branches";
import { cn } from "@/lib/utils";
import type { LandingTarget } from "./cloneDestination";
import { useCreatePlan } from "./createPlan";
import { FlowBody, FlowFooter } from "./FlowChrome";
import {
  AFTER_PULL_POSITION,
  framePosition,
  type Landing,
  LANDS_HERE,
  overallProgress,
  type StepState,
  stepPosition,
  stepStates,
} from "./pullSteps";

type ExtraRow = { title: string; detail: ReactNode };
const NO_EXTRA_ROWS: ExtraRow[] = [];

type Row = ExtraRow & {
  position: number;
  // A step this run leaves out (setup switched off, a clean tree with
  // nothing to re-apply). Listed so its absence is on the record.
  skipped?: boolean;
};

// A row the run only sometimes has.
const rowIf = (listed: boolean, row: Row): Row[] => (listed ? [row] : []);

export type PullProgressProps = {
  frame: SyncPullProgress | null;
  // The create phases the run has reported (usePullProgress).
  phasesSeen: ReadonlySet<CreatePhase>;
  // The source worktree being brought here.
  worktree: Worktree;
  // Where it lands: the project whose carry-over, setup script and
  // ports the create's rows name, or the clone the run opens with.
  target: LandingTarget;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
  // The review's setup switch.
  runSetup: boolean;
  // Set on the failed view. Refusals toast centrally, so they get a
  // one-line stand-in here instead of the raw marker.
  error?: unknown;
  // The cancelled view: the run stopped where the list shows because
  // the user asked, and the destination is as it was.
  cancelled?: boolean;
  // The running view's cancel, and the wait for the run to settle once
  // it was asked (the mutation ends the view, cancelled or done).
  cancelling?: boolean;
  onCancel: () => void;
  onClose: () => void;
  onRetry: () => void;
  // Steps after the pull itself (the mirror's session open), running
  // once the apply frame has landed. The mutation settling ends the
  // view, so a row here never reads as done.
  extraRows?: ExtraRow[];
  // The transplant's files step (the ignored files the leave-out rule
  // admits), as its row's caption. Absent on a mirror: its own session
  // carries the files.
  filesDetail?: string;
  sourcePart?: string;
  runningNote?: string;
  failedNote?: string;
  cancelledNote?: string;
  progressLabel?: string;
  // Where it lands (pullSteps.ts). On a peer, `thisDeviceLabel` names
  // that peer, and a refused command is its refusal, not the source's.
  landing?: Landing;
};

// The create's rows read the destination's project while the dialog
// sits under the source's scope, so the view re-pins itself.
export function PullProgress(props: PullProgressProps) {
  return (
    <DestinationScope>
      <ProgressView {...props} />
    </DestinationScope>
  );
}

function ProgressView({
  frame,
  phasesSeen,
  worktree,
  target,
  sourceDeviceLabel,
  thisDeviceLabel,
  runSetup,
  error,
  cancelled = false,
  cancelling = false,
  onCancel,
  onClose,
  onRetry,
  extraRows = NO_EXTRA_ROWS,
  filesDetail,
  sourcePart = "source, untouched",
  runningNote = `Keep this window open. Nothing on ${sourceDeviceLabel} changes until you decide at the finish step.`,
  failedNote = `The copy on ${sourceDeviceLabel} is untouched. If the worktree already landed here, open it from the sidebar instead of retrying.`,
  cancelledNote,
  progressLabel = "Transplant progress",
  landing = LANDS_HERE,
}: PullProgressProps) {
  const cancelledWords =
    cancelledNote ??
    `Nothing landed ${landing.on}, and the copy on ${sourceDeviceLabel} is untouched.`;
  // The two ends as the devices they are: the dialog sits under the
  // source's scope and the destination provider names where it lands
  // (this machine unless a peer was picked).
  const sourceIcon = useDeviceIcon(useHostScope().deviceId);
  const destinationIcon = useDeviceIcon(useDestinationScope().deviceId);
  const plan = useCreatePlan(target.project);
  const projectName = target.project
    ? target.project.name
    : target.clone.projectName;
  // Both stop the list where it stands. Only a failure has an error to
  // show, and only a cancel is the user's own doing.
  const ended: Ended =
    error !== undefined ? "failed" : cancelled ? "cancelled" : null;
  const failed = ended === "failed";
  const dirty = worktree.changedCount > 0;
  const folder = pullWorktreeName(worktree);
  const landingBranch = pullLandingBranch(worktree);
  const pullDone = frame?.step === "apply" && extraRows.length > 0;
  const ratio = pullDone ? 0.97 : overallProgress(frame);
  const caption = (step: "clone" | "transfer" | "files") =>
    frame?.step === step && frame.totalBytes
      ? `${formatBytes(frame.bytes ?? 0)} of ${formatBytes(frame.totalBytes)}`
      : null;
  const cloneCaption = caption("clone");
  const transferCaption = caption("transfer");
  const filesCaption = caption("files");

  const at = pullDone
    ? AFTER_PULL_POSITION
    : framePosition(frame, target.clone !== undefined);
  // The create's phases are listed from the plan, which is a reading
  // of the project made before the create ran, and settled by what the
  // run reports: a phase it reports gets its row even unplanned, and a
  // planned one the run went past without reporting did not happen, so
  // it reads skipped rather than done.
  const phaseRow = (
    phase: CreatePhase,
    planned: boolean,
    row: ExtraRow & { skipped?: boolean },
  ): Row[] =>
    rowIf(planned || phasesSeen.has(phase), {
      ...row,
      position: stepPosition(phase),
      skipped:
        row.skipped || (at > stepPosition(phase) && !phasesSeen.has(phase)),
    });

  // Only what this run will do, or pointedly will not: carry-over and
  // ports are listed when the project has them, setup whenever it has
  // a script (skipped with the switch off), the re-apply always.
  const rows: Row[] = [
    ...rowIf(target.clone !== undefined, {
      title: `Clone ${projectName} to ${thisDeviceLabel}`,
      detail: cloneCaption ?? (
        <span className="font-mono">{target.clone?.dest}</span>
      ),
      position: stepPosition("clone"),
    }),
    {
      title: `Capture on ${sourceDeviceLabel}`,
      detail: dirty
        ? pluralize(worktree.changedCount, "uncommitted file")
        : "clean tree, nothing to capture",
      position: stepPosition("capture"),
    },
    {
      title: "Transfer over the device link",
      detail:
        transferCaption ??
        (dirty ? "the branch and your changes" : "the branch"),
      position: stepPosition("transfer"),
    },
    {
      title: `Create the worktree on ${thisDeviceLabel}`,
      detail: (
        <>
          <span className="font-mono">{landingBranch}</span>
          {folder !== undefined && (
            <>
              {" in "}
              <span className="font-mono">{folder}</span>
            </>
          )}
        </>
      ),
      position: stepPosition("create"),
    },
    ...phaseRow("carryOver", plan.carryOverCount > 0, {
      title: "Carry files over",
      detail:
        plan.carryOverCount > 0
          ? `${pluralize(plan.carryOverCount, "path")} from ${projectName}`
          : `from ${projectName}`,
    }),
    ...phaseRow("setup", plan.setupCommand !== "", {
      title: "Run the setup script",
      detail: <span className="font-mono">{plan.setupCommand}</span>,
      skipped: !runSetup,
    }),
    ...phaseRow("portPoolProvision", plan.provisionsPorts, {
      title: "Provision ports",
      detail: "port-pool",
    }),
    {
      title: "Re-apply your changes",
      detail: dirty ? "unstaged and staged, as they were" : "clean tree",
      position: stepPosition("apply"),
      skipped: !dirty,
    },
    ...rowIf(filesDetail !== undefined, {
      title: landing.onPeer
        ? "Send the ignored files over"
        : "Bring the ignored files over",
      detail: filesCaption ?? filesDetail,
      position: stepPosition("files"),
    }),
    ...extraRows.map((row, index) => ({
      ...row,
      position: AFTER_PULL_POSITION + index,
    })),
  ];
  const states = stepStates(rows, at);

  return (
    <>
      <FlowBody>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <DeviceEnd
              icon={sourceIcon}
              name={sourceDeviceLabel}
              part={sourcePart}
            />
            <div className="min-w-0 flex-1 space-y-1.5">
              <p className="h-4 truncate text-center text-xs text-sky-700 dark:text-sky-300">
                {ended !== null
                  ? ENDED_LOOK[ended].word
                  : cancelling
                    ? "cancelling"
                    : (cloneCaption ?? transferCaption ?? filesCaption ?? " ")}
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
                    ended === null ? "bg-sky-500" : ENDED_LOOK[ended].solid,
                  )}
                  style={{ width: `${Math.round(ratio * 100)}%` }}
                />
              </div>
            </div>
            <DeviceEnd
              icon={destinationIcon}
              name={thisDeviceLabel}
              part="destination"
              align="end"
            />
          </div>

          <ol className="space-y-1">
            {rows.map((row, index) => (
              <StepRow
                key={row.title}
                state={states[index]}
                ended={ended}
                title={row.title}
                detail={row.detail}
              />
            ))}
          </ol>

          {failed &&
            (isCommandRefusedError(error) ? (
              <ErrorBanner>
                {peerReadOnlyNote(
                  landing.onPeer ? thisDeviceLabel : sourceDeviceLabel,
                )}
              </ErrorBanner>
            ) : (
              <ErrorBanner
                message={errorMessageOf(error)}
                title="The transfer failed"
              />
            ))}
        </div>
      </FlowBody>

      {ended !== null ? (
        <FlowFooter note={cancelled ? cancelledWords : failedNote}>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        </FlowFooter>
      ) : (
        <FlowFooter
          note={
            cancelling
              ? `Cancelling. Whatever landed ${landing.on} is being removed.`
              : runningNote
          }
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={cancelling}
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </Button>
        </FlowFooter>
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
  icon: DeviceIcon;
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
      <DeviceGlyph icon={icon} className="size-4 text-muted-foreground" />
      <div className="leading-tight">
        <p className="text-sm font-medium">{name}</p>
        <p className="text-2xs text-muted-foreground">{part}</p>
      </div>
    </div>
  );
}

// How a run ended, null while it runs, and how each ending looks: the
// bar and the mark it stopped on, the row's wash, its word.
type Ended = "failed" | "cancelled" | null;
const ENDED_LOOK: Record<
  Exclude<Ended, null>,
  { word: string; solid: string; soft: string; icon: LucideIcon }
> = {
  failed: {
    word: "stopped",
    solid: "bg-rose-500",
    soft: "bg-rose-500/10",
    icon: AlertCircle,
  },
  cancelled: {
    word: "cancelled",
    solid: "bg-amber-500",
    soft: "bg-amber-500/10",
    icon: Ban,
  },
};

function StepRow({
  state,
  ended,
  title,
  detail,
}: {
  state: StepState;
  ended: Ended;
  title: string;
  detail: ReactNode;
}) {
  // The run ended on this row, or it is still going here.
  const endedHere = state === "running" ? ended : null;
  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm",
        state === "running" && ended === null && "bg-sky-500/10",
        endedHere !== null && ENDED_LOOK[endedHere].soft,
        (state === "queued" || state === "skipped") && "text-muted-foreground",
      )}
    >
      <StepMark state={state} ended={endedHere} />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{title}</span>
        <span className="ml-2 text-xs text-muted-foreground">{detail}</span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {endedHere === null ? state : ENDED_LOOK[endedHere].word}
      </span>
    </li>
  );
}

function StepMark({ state, ended }: { state: StepState; ended: Ended }) {
  if (ended !== null || state === "done") {
    const look = ended === null ? null : ENDED_LOOK[ended];
    const Icon = look?.icon ?? Check;
    return (
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full text-background",
          look?.solid ?? "bg-emerald-500",
        )}
      >
        <Icon className="size-2.5" />
      </span>
    );
  }
  if (state === "skipped") {
    return (
      <span
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center rounded-full border border-muted-foreground/40 text-muted-foreground"
      >
        <Minus className="size-2.5" />
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
