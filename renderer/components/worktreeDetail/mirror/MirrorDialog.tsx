// The mirror flow, the transplant dialog's sibling on the same frame:
// three steps on one rail. Review shows the source, both devices, and
// what stays out (the one choice a mirror has). Mirror is the pull
// with its progress frames, plus the session open on top. Live is
// proof: the session's first verdict, and the way to the local copy's
// page, where the footer's Mirror button takes over.
import { pullWorktreeName } from "@/lib/remote/pullWorktreeName";
import { ArrowRight, Check, Monitor, RefreshCw } from "lucide-react";
import type { MirrorSession } from "@shared/ipc/modules/mirror";
import type { Project, Worktree } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip-button";
import { PathSpan } from "@/components/ui/path-span";
import { SectionHeading } from "@/components/ui/section-heading";
import { StatusDot } from "@/components/ui/status-dot";
import { useLocalDeviceName } from "@/hooks/account/useAccount";
import { LocalHostScope } from "@/hooks/remote/useHostScope";
import { useMirrors, useStartMirror } from "@/hooks/remote/useMirrors";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import {
  type FlowStage,
  PullFlowFrame,
  usePullFlow,
} from "../transplant/PullFlow";
import {
  TransplantBody,
  TransplantFooter,
} from "../transplant/TransplantChrome";
import { SetupToggle } from "../transplant/SetupToggle";
import { TransplantProgress } from "../transplant/TransplantProgress";
import {
  DestinationFolder,
  DestinationRow,
  PullReviewFooter,
  SourceCard,
} from "../transplant/TransplantReview";
import { stepHeadline } from "../transplant/transplantSteps";
import {
  selectionSummary,
  sessionSummary,
  type PullChoiceState,
  usePullChoice,
} from "./ignoreChoice";
import { MirrorIgnorePicker } from "./MirrorIgnorePicker";
import { describeMirror } from "./mirrorStatus";

const STEPS = ["Review", "Mirror", "Live"] as const;

const TITLES: Record<FlowStage, string> = {
  review: "Mirror worktree",
  running: "Mirroring",
  failed: "Mirror stopped",
  done: "Mirror live",
};

export function MirrorDialog({
  worktree,
  project,
  sourceIdentity,
  localProject,
  sourceDeviceLabel,
  onClose,
}: {
  // The source pair, on the remote device this page is scoped to.
  worktree: Worktree;
  project: Project;
  sourceIdentity: string;
  // The identity-matched project on this machine the copy lands in.
  localProject: Project;
  sourceDeviceLabel: string;
  onClose: () => void;
}) {
  const thisDeviceLabel = useLocalDeviceName();
  const mirror = useStartMirror({
    worktree,
    sourceProjectId: project.id,
    sourceIdentity,
    localProjectId: localProject.id,
  });
  // Under the source scope: its ignored list walks the checkout over
  // the device link.
  const pull = usePullChoice(project.id, worktree.id);
  const { stage, elapsed, progress, start, open } = usePullFlow({
    mutation: mirror,
    sourceWorktreeId: worktree.id,
    choice: pull.choice,
    onClose,
  });
  const summary = selectionSummary(pull.selection);

  return (
    <PullFlowFrame
      stage={stage}
      elapsed={elapsed}
      reviewIcon={RefreshCw}
      titles={TITLES}
      thisDeviceLabel={thisDeviceLabel}
      steps={STEPS}
      stepsLabel="Mirror steps"
      onClose={onClose}
      headline={
        <>
          {stage === "review" && (
            <>
              A live copy of{" "}
              <span className="font-mono">{worktree.branch}</span> here, kept in
              step with {sourceDeviceLabel}.
            </>
          )}
          {stage === "running" &&
            (progress.frame === null
              ? "Reaching the source."
              : progress.frame.step === "apply" && !mirror.isSuccess
                ? "Opening the mirror."
                : `${stepHeadline(progress.frame, sourceDeviceLabel)}.`)}
          {stage === "failed" && `Nothing on ${sourceDeviceLabel} changed.`}
          {stage === "done" && (
            <>
              <span className="font-mono">{worktree.branch}</span> is on both
              devices and stays in step.
            </>
          )}
        </>
      }
    >
      {stage === "review" && (
        <MirrorReview
          worktree={worktree}
          project={project}
          localProject={localProject}
          sourceDeviceLabel={sourceDeviceLabel}
          thisDeviceLabel={thisDeviceLabel}
          pull={pull}
          onCancel={onClose}
          onStart={start}
        />
      )}
      {(stage === "running" || stage === "failed") && (
        <TransplantProgress
          frame={progress.frame}
          phasesSeen={progress.phasesSeen}
          sourceDeviceLabel={sourceDeviceLabel}
          thisDeviceLabel={thisDeviceLabel}
          worktree={worktree}
          localProject={localProject}
          runSetup={pull.runSetup}
          error={stage === "failed" ? mirror.error : undefined}
          onClose={onClose}
          onRetry={start}
          extraRows={[
            {
              title: "Open the mirror",
              detail: summary ?? "both ways",
            },
          ]}
          sourcePart="source, keeps its copy"
          progressLabel="Mirror progress"
          runningNote="Keep this window open."
          failedNote="If the worktree already landed here, open it from the sidebar rather than retrying."
        />
      )}
      {stage === "done" && mirror.data && (
        <LocalHostScope>
          <MirrorLive
            session={mirror.data.session}
            landed={mirror.data.worktree}
            branch={worktree.branch}
            sourceDeviceLabel={sourceDeviceLabel}
            thisDeviceLabel={thisDeviceLabel}
            dirtyApplied={!mirror.data.captured || mirror.data.dirtyApplied}
            onClose={onClose}
            onOpen={open}
          />
        </LocalHostScope>
      )}
    </PullFlowFrame>
  );
}

// Step 1: the source, what stays out, and the two devices that will
// hold the branch. The source half reads the remote device the page
// is scoped to. The device half re-pins to this machine, like the
// transplant's.
function MirrorReview({
  worktree,
  project,
  localProject,
  sourceDeviceLabel,
  thisDeviceLabel,
  pull,
  onCancel,
  onStart,
}: {
  worktree: Worktree;
  project: Project;
  localProject: Project;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
  pull: PullChoiceState;
  onCancel: () => void;
  onStart: () => void;
}) {
  return (
    <>
      <TransplantBody>
        <div className="grid gap-5 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            <section className="space-y-2">
              <SectionHeading>Source</SectionHeading>
              <SourceCard
                worktree={worktree}
                project={project}
                sourceDeviceLabel={sourceDeviceLabel}
              />
            </section>

            <MirrorIgnorePicker
              value={pull.selection}
              onChange={pull.setSelection}
              ignored={pull.ignored}
              worktree={{
                projectId: project.id,
                id: worktree.id,
                path: worktree.path,
              }}
            />
          </div>

          <LocalHostScope>
            <div className="flex min-w-0 flex-col gap-5">
              <section className="space-y-2">
                <SectionHeading>On both</SectionHeading>
                <ul className="space-y-1.5">
                  <DestinationRow
                    worktree={worktree}
                    localProject={localProject}
                    thisDeviceLabel={thisDeviceLabel}
                  />
                  <li className="flex items-center gap-2.5 rounded-lg bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
                    <span
                      aria-hidden
                      className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted-foreground/20"
                    >
                      <Check className="size-2.5" />
                    </span>
                    <Monitor aria-hidden className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate font-medium">
                        {sourceDeviceLabel}
                      </span>
                      <span className="block truncate text-[11px]">
                        keeps its copy
                      </span>
                    </span>
                    <span className="text-xs">source</span>
                  </li>
                </ul>
              </section>

              <DestinationFolder
                localProject={localProject}
                thisDeviceLabel={thisDeviceLabel}
                name={pullWorktreeName(worktree)}
              />

              <SetupToggle
                localProject={localProject}
                thisDeviceLabel={thisDeviceLabel}
                checked={pull.runSetup}
                onChange={pull.setRunSetup}
                pinned={pull.setupPinned}
              />
            </div>
          </LocalHostScope>
        </div>
      </TransplantBody>

      <LocalHostScope>
        <PullReviewFooter
          worktree={worktree}
          localProject={localProject}
          waiting={pull.waiting}
          blocked={pull.blocked}
          idleNote="Stop any time. Stopping removes the copy here."
          startLabel="Start mirroring"
          onCancel={onCancel}
          onStart={onStart}
        />
      </LocalHostScope>
    </>
  );
}

// Step 3: the copy is here and the session is up. Read under the local
// scope: the session is this machine's fact.
function MirrorLive({
  session,
  landed,
  branch,
  sourceDeviceLabel,
  thisDeviceLabel,
  dirtyApplied,
  onClose,
  onOpen,
}: {
  session: string;
  landed: Worktree;
  branch: string;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
  dirtyApplied: boolean;
  onClose: () => void;
  onOpen: () => void;
}) {
  const { sessions } = useMirrors();
  const { data: runtime } = useRuntimeInfo();
  const live: MirrorSession | undefined = sessions.find(
    (entry) => entry.session === session,
  );
  const view = live === undefined ? null : describeMirror(live);
  const summary = live === undefined ? null : sessionSummary(live);
  return (
    <>
      <TransplantBody>
        <section className="space-y-2">
          <SectionHeading>On {thisDeviceLabel}</SectionHeading>
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-emerald-500/10 p-3">
            <span
              aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-background"
            >
              <RefreshCw className="size-4" />
            </span>
            <div className="min-w-0 flex-1 basis-64 space-y-1.5">
              <p className="truncate font-mono text-sm font-semibold">
                {branch}
              </p>
              <PathSpan
                path={landed.path}
                home={runtime?.homedir ?? null}
                className="min-w-0 truncate font-mono text-xs text-muted-foreground"
                copyable
              />
              <div className="flex flex-wrap gap-1.5">
                <Chip>
                  {view === null ? (
                    <StatusDot tone="sky" label="opening" />
                  ) : (
                    <StatusDot tone={view.tone} label={view.label} />
                  )}
                </Chip>
                {summary !== null && <Chip>{summary}</Chip>}
                {!dirtyApplied && (
                  <Chip className="text-amber-700 dark:text-amber-300">
                    changes stayed on {sourceDeviceLabel}
                  </Chip>
                )}
              </div>
            </div>
          </div>
        </section>
      </TransplantBody>
      <TransplantFooter note="Pause, stop, or change what stays out from the Mirror button on its page.">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button size="sm" onClick={onOpen}>
          Open here
          <ArrowRight />
        </Button>
      </TransplantFooter>
    </>
  );
}
