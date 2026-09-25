// Step 2 of the transplant: both devices on screen with the pull's
// progress between them, and the run as named steps read off the
// orchestrator's frames, so a stall is attributable to one step. The
// create is spelled out as the phases this project actually has
// (carry-over, the setup script by its command, ports), and a step
// the run leaves out (setup switched off, a clean tree) is listed as
// skipped rather than dropped. Also the failed view: the same list,
// frozen where it stopped, with the error and a retry.
import { AlertCircle, Check, Minus } from "lucide-react";
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

type Props = {
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
  progressLabel?: string;
  // Where it lands (pullSteps.ts). On a peer, `thisDeviceLabel` names
  // that peer, and a refused command is its refusal, not the source's.
  landing?: Landing;
  // False when the create's phases are not reported back (it runs on a
  // peer): a planned phase the run has passed then reads done, where a
  // reported run would have shown it skipped.
  phasesReported?: boolean;
};

// The create's rows read the destination's project while the dialog
// sits under the source's scope, so the view re-pins itself.
export function PullProgress(props: Props) {
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
  onClose,
  onRetry,
  extraRows = NO_EXTRA_ROWS,
  filesDetail,
  sourcePart = "source, untouched",
  runningNote = `Keep this window open. Nothing on ${sourceDeviceLabel} changes until you decide at the finish step.`,
  failedNote = `The copy on ${sourceDeviceLabel} is untouched. If the worktree already landed here, open it from the sidebar instead of retrying.`,
  progressLabel = "Transplant progress",
  landing = LANDS_HERE,
  phasesReported = true,
}: Props) {
  // The two ends as the devices they are: the dialog sits under the
  // source's scope and the destination provider names where it lands
  // (this machine unless a peer was picked).
  const sourceIcon = useDeviceIcon(useHostScope().deviceId);
  const destinationIcon = useDeviceIcon(useDestinationScope().deviceId);
  const plan = useCreatePlan(target.project);
  const projectName = target.project
    ? target.project.name
    : target.clone.projectName;
  const failed = error !== undefined;
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
        row.skipped ||
        (phasesReported && at > stepPosition(phase) && !phasesSeen.has(phase)),
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
                {failed
                  ? "stopped"
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
                    failed ? "bg-rose-500" : "bg-sky-500",
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
                failed={failed}
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

      {failed ? (
        <FlowFooter note={failedNote}>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        </FlowFooter>
      ) : (
        <FlowFooter note={runningNote} />
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

function StepRow({
  state,
  failed,
  title,
  detail,
}: {
  state: StepState;
  failed: boolean;
  title: string;
  detail: ReactNode;
}) {
  const stopped = failed && state === "running";
  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm",
        state === "running" && !failed && "bg-sky-500/10",
        stopped && "bg-rose-500/10",
        (state === "queued" || state === "skipped") && "text-muted-foreground",
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
