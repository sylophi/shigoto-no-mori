// The mirror flow, the transplant dialog's sibling on the same frame:
// three steps on one rail. Review shows the source, both devices, and
// what stays out (the one choice a mirror has). Mirror is the pull
// with its progress frames, plus the session open on top. Live is
// proof: the session's first verdict, and the way to the copy's page.
// The flow runs both ways: MirrorDialog copies a peer's worktree here,
// MirrorToDialog copies one of this device's to a peer (under that
// peer's DestinationProvider). The session runs on this device either
// way, and its Mirror button sits on this device's worktree page. A
// primary checkout takes the same flow, its copy on a branch of its
// own (shared/git/branches.ts), which the words below say when the
// two names differ.
import { useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import { pullLandingBranch } from "@shared/git/branches";
import type { UseMutationResult } from "@tanstack/react-query";
import type { MirrorSession } from "@shared/ipc/modules/mirror";
import type { Project, Worktree } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip-button";
import { SectionHeading } from "@/components/ui/section-heading";
import { StatusDot } from "@/components/ui/status-dot";
import { useLocalDeviceName } from "@/hooks/account/useAccount";
import {
  DestinationProvider,
  DestinationScope,
  LocalHostScope,
} from "@/hooks/remote/useHostScope";
import {
  useMirrors,
  useStartMirror,
  useStartMirrorTo,
} from "@/hooks/remote/useMirrors";
import type { LandingChoice } from "@/hooks/remote/usePullWorktree";
import { type FlowStage, PullFlowFrame, usePullFlow } from "../flow/PullFlow";
import {
  type CloneDestination,
  useCloneDestination,
} from "../flow/cloneDestination";
import { FlowBody, FlowFooter, LandedPath } from "../flow/FlowChrome";
import { type PeerTarget, usePeerDestination } from "../flow/peerTargets";
import { PullProgress } from "../flow/PullProgress";
import {
  type DestinationPick,
  PullReviewFooter,
  ReviewDevicesColumn,
  SourceCard,
} from "../flow/PullReview";
import { type Landing, LANDS_HERE, stepHeadline } from "../flow/pullSteps";
import {
  selectionSummary,
  sessionSummary,
  type PullChoiceState,
  usePullChoice,
} from "../flow/ignoreChoice";
import { PullLeaveOut } from "../flow/PullLeaveOut";
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
  // Absent when this machine has none: the start clones the repo
  // here first, where the review says (flow/cloneDestination.tsx).
  localProject: Project | undefined;
  sourceDeviceLabel: string;
  onClose: () => void;
}) {
  const thisDeviceLabel = useLocalDeviceName();
  const mirror = useStartMirror({
    worktree,
    sourceProjectId: project.id,
    sourceIdentity,
  });
  // Read once: the start's own clone registers a project mid-run,
  // which would otherwise turn the running view into a flow that never
  // cloned anything.
  const [landing] = useState(localProject);
  const clone = useCloneDestination(project);
  return (
    <MirrorFlow
      worktree={worktree}
      project={project}
      sourceIdentity={sourceIdentity}
      localProject={landing}
      clone={landing === undefined ? clone : undefined}
      sourceDeviceLabel={sourceDeviceLabel}
      thisDeviceLabel={thisDeviceLabel}
      mirror={mirror}
      onClose={onClose}
    />
  );
}

// The same flow the other way: a live copy of one of THIS device's
// worktrees on a peer that holds the same repo.
export function MirrorToDialog({
  worktree,
  project,
  sourceIdentity,
  targets,
  onClose,
}: {
  // The source pair, on this machine.
  worktree: Worktree;
  project: Project;
  sourceIdentity: string;
  // The peers holding the same repo (flow/peerTargets.ts).
  targets: PeerTarget[];
  onClose: () => void;
}) {
  const { picked, flow } = usePeerDestination(targets);
  const mirror = useStartMirrorTo(worktree, picked?.deviceId);
  return (
    <DestinationProvider peer={picked}>
      <MirrorFlow
        worktree={worktree}
        project={project}
        sourceIdentity={sourceIdentity}
        {...flow}
        mirror={mirror}
        onClose={onClose}
      />
    </DestinationProvider>
  );
}

function MirrorFlow({
  worktree,
  project,
  sourceIdentity,
  localProject,
  clone,
  sourceDeviceLabel,
  thisDeviceLabel,
  landing = LANDS_HERE,
  toPeer,
  mirror,
  onClose,
}: {
  worktree: Worktree;
  project: Project;
  sourceIdentity: string;
  // The landing side, named as the flow's pieces name it
  // (flow/PullReview.tsx says why): this machine, or the picked peer.
  // Absent on the review of a flow to a peer with none picked yet,
  // which Start waits on, and on a flow here with no checkout of the
  // repo, where `clone` says where the start makes one.
  localProject: Project | undefined;
  clone?: CloneDestination;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
  // A flow to a peer: the words for landing there, and the pick of
  // which peer (flow/peerTargets.ts makes both).
  landing?: Landing;
  toPeer?: DestinationPick;
  mirror: UseMutationResult<
    {
      worktree: Worktree;
      captured: boolean;
      dirtyApplied: boolean;
      session: string;
    },
    Error,
    LandingChoice
  >;
  onClose: () => void;
}) {
  // Under the source scope: its ignored list walks the checkout over
  // the device link.
  const pull = usePullChoice(project.id, worktree.id, sourceIdentity);
  const { stage, elapsed, progress, start, open } = usePullFlow({
    mutation: mirror,
    sourceWorktreeId: worktree.id,
    choice: { ...pull.choice, cloneInto: clone?.cloneInto },
    destinationDeviceId: toPeer?.pickedId ?? undefined,
    onClose,
  });
  const summary = selectionSummary(pull.selection);
  const landingBranch = pullLandingBranch(worktree);
  const renamed = landingBranch !== worktree.branch;

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
          {stage === "review" &&
            (renamed ? (
              <>
                A live copy of {sourceDeviceLabel}'s primary checkout{" "}
                {landing.on}, on{" "}
                <span className="font-mono">{landingBranch}</span>, kept in step
                with its <span className="font-mono">{worktree.branch}</span>.
              </>
            ) : (
              <>
                A live copy of{" "}
                <span className="font-mono">{worktree.branch}</span>{" "}
                {landing.on}, kept in step with {sourceDeviceLabel}.
              </>
            ))}
          {stage === "running" &&
            (progress.frame === null
              ? landing.onPeer
                ? `Reaching ${thisDeviceLabel}.`
                : "Reaching the source."
              : progress.frame.step === "apply" && !mirror.isSuccess
                ? "Opening the mirror."
                : `${stepHeadline(progress.frame, sourceDeviceLabel, landing)}.`)}
          {stage === "failed" && `Nothing on ${sourceDeviceLabel} changed.`}
          {stage === "done" &&
            (renamed ? (
              <>
                <span className="font-mono">{landingBranch}</span> {landing.on}{" "}
                follows {sourceDeviceLabel}'s{" "}
                <span className="font-mono">{worktree.branch}</span> and stays
                in step.
              </>
            ) : (
              <>
                <span className="font-mono">{worktree.branch}</span> is on both
                devices and stays in step.
              </>
            ))}
        </>
      }
    >
      {stage === "review" && (
        <MirrorReview
          worktree={worktree}
          project={project}
          localProject={localProject}
          clone={clone}
          sourceDeviceLabel={sourceDeviceLabel}
          thisDeviceLabel={thisDeviceLabel}
          landing={landing}
          toPeer={toPeer}
          pull={pull}
          onCancel={onClose}
          onStart={start}
        />
      )}
      {(stage === "running" || stage === "failed") &&
        (localProject || clone) && (
          <PullProgress
            frame={progress.frame}
            phasesSeen={progress.phasesSeen}
            sourceDeviceLabel={sourceDeviceLabel}
            thisDeviceLabel={thisDeviceLabel}
            worktree={worktree}
            localProject={localProject}
            cloning={clone}
            runSetup={pull.runSetup}
            landing={landing}
            phasesReported={!landing.onPeer}
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
            failedNote={`If the worktree already landed ${landing.on}, open it from the sidebar rather than retrying.`}
          />
        )}
      {stage === "done" && mirror.data && (
        <LocalHostScope>
          <MirrorLive
            session={mirror.data.session}
            landed={mirror.data.worktree}
            branch={landingBranch}
            sourceDeviceLabel={sourceDeviceLabel}
            thisDeviceLabel={thisDeviceLabel}
            landing={landing}
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
// hold the branch. The source half reads the device the page is scoped
// to. The device half re-pins to the landing device (DestinationScope),
// like the transplant's.
function MirrorReview({
  worktree,
  project,
  localProject,
  clone,
  sourceDeviceLabel,
  thisDeviceLabel,
  landing = LANDS_HERE,
  toPeer,
  pull,
  onCancel,
  onStart,
}: {
  worktree: Worktree;
  project: Project;
  localProject: Project | undefined;
  clone?: CloneDestination;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
  landing?: Landing;
  toPeer?: DestinationPick;
  pull: PullChoiceState;
  onCancel: () => void;
  onStart: () => void;
}) {
  return (
    <>
      <FlowBody>
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

            <PullLeaveOut
              pull={pull}
              worktree={{
                projectId: project.id,
                id: worktree.id,
                path: worktree.path,
              }}
            />
          </div>

          <ReviewDevicesColumn
            heading="On both"
            sourceNote="keeps its copy"
            sourceKeeps
            toPeer={toPeer}
            worktree={worktree}
            localProject={localProject}
            clone={clone}
            sourceDeviceLabel={sourceDeviceLabel}
            thisDeviceLabel={thisDeviceLabel}
            pull={pull}
          />
        </div>
      </FlowBody>

      <DestinationScope>
        <PullReviewFooter
          worktree={worktree}
          localProject={localProject}
          cloning={localProject === undefined && clone !== undefined}
          landing={landing}
          waiting={pull.waiting}
          blocked={pull.blocked}
          idleNote={`Stop any time. Stopping removes the copy ${landing.on}.`}
          startLabel="Start mirroring"
          onCancel={onCancel}
          onStart={onStart}
        />
      </DestinationScope>
    </>
  );
}

// Step 3: the copy has landed and the session is up. Read under the
// local scope: the session is this machine's fact, whichever device
// holds the copy.
function MirrorLive({
  session,
  landed,
  branch,
  sourceDeviceLabel,
  thisDeviceLabel,
  landing,
  dirtyApplied,
  onClose,
  onOpen,
}: {
  session: string;
  landed: Worktree;
  branch: string;
  sourceDeviceLabel: string;
  // The device holding the copy, and the words for that.
  thisDeviceLabel: string;
  landing: Landing;
  dirtyApplied: boolean;
  onClose: () => void;
  onOpen: () => void;
}) {
  const { sessions } = useMirrors();
  const live: MirrorSession | undefined = sessions.find(
    (entry) => entry.session === session,
  );
  const view = live === undefined ? null : describeMirror(live);
  const summary = live === undefined ? null : sessionSummary(live);
  return (
    <>
      <FlowBody>
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
              <LandedPath path={landed.path} />
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
      </FlowBody>
      <FlowFooter
        note={
          landing.onPeer
            ? "Pause, stop, or change what stays out from the Mirror button on this worktree's page."
            : "Pause, stop, or change what stays out from the Mirror button on its page."
        }
      >
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button size="sm" onClick={onOpen}>
          Open {landing.here}
          <ArrowRight />
        </Button>
      </FlowFooter>
    </>
  );
}
