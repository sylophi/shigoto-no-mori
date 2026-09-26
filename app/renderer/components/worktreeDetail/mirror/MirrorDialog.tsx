// The mirror flow, the transplant dialog's sibling on the same frame:
// three steps on one rail. Review shows the source, both devices, and
// what stays out (the one choice a mirror has). Mirror is the move (a
// send from the original's device) with its progress frames, plus the
// session open on top. Live is
// proof: the session's first verdict, and the way to the copy's page.
// The flow runs both ways: MirrorDialog copies a peer's worktree here,
// MirrorToDialog copies one of this device's to a peer (under that
// peer's DestinationProvider). Either way the session runs on the
// device holding the original: the peer this dialog is scoped to for
// MirrorDialog, which sends the copy here, this device for
// MirrorToDialog. Its Mirror button sits on both worktrees' pages. A
// primary checkout takes the same flow, its copy on a branch of its
// own (shared/git/branches.ts), which the words below say when the
// two names differ.
import type { ReactNode } from "react";
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
  LocalHostScope,
} from "@/hooks/remote/useHostScope";
import { useMirrors, useStartMirror } from "@/hooks/remote/useMirrors";
import type { LandingChoice } from "@/hooks/remote/useMoveWorktree";
import { type FlowStage, PullFlowFrame, usePullFlow } from "../flow/PullFlow";
import { FlowBody, FlowFooter, LandedPath } from "../flow/FlowChrome";
import { type PeerTarget, usePeerDestination } from "../flow/peerTargets";
import { type DestinationPick, PullReviewStep } from "../flow/PullReview";
import { type Landing, LANDS_HERE, stepHeadline } from "../flow/pullSteps";
import { selectionSummary, sessionSummary } from "../flow/ignoreChoice";
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
    direction: "pull",
    source: { worktree, sourceProjectId: project.id, sourceIdentity },
  });
  return (
    <MirrorFlow
      worktree={worktree}
      project={project}
      sourceIdentity={sourceIdentity}
      localProject={localProject}
      sourceDeviceLabel={sourceDeviceLabel}
      thisDeviceLabel={thisDeviceLabel}
      mirror={mirror}
      onClose={onClose}
    />
  );
}

// The same flow the other way: a live copy of one of THIS device's
// worktrees on a peer (which clones the repo first when it has no
// checkout).
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
  // The peers it could go to (flow/peerTargets.ts).
  targets: PeerTarget[];
  onClose: () => void;
}) {
  const { picked, flow } = usePeerDestination(targets);
  const mirror = useStartMirror({
    direction: "send",
    worktree,
    targetDeviceId: picked?.deviceId,
  });
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
  // repo, which the start clones first (flow/cloneDestination.tsx).
  localProject: Project | undefined;
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
  const flow = usePullFlow({
    mutation: mirror,
    worktree,
    project,
    sourceIdentity,
    localProject,
    toPeer,
    onClose,
  });
  const { stage, progress, start, open, pull, target } = flow;
  const summary = selectionSummary(pull.selection);
  const landingBranch = pullLandingBranch(worktree);
  const renamed = landingBranch !== worktree.branch;

  return (
    <PullFlowFrame
      flow={flow}
      worktree={worktree}
      reviewIcon={RefreshCw}
      titles={TITLES}
      sourceDeviceLabel={sourceDeviceLabel}
      thisDeviceLabel={thisDeviceLabel}
      landing={landing}
      steps={STEPS}
      stepsLabel="Mirror steps"
      progressExtras={{
        extraRows: [
          {
            title: "Open the mirror",
            detail: summary ?? "both ways",
          },
        ],
        sourcePart: "source, keeps its copy",
        progressLabel: "Mirror progress",
        runningNote: "Keep this window open.",
        failedNote: `If the worktree already landed ${landing.on}, open it from the sidebar rather than retrying.`,
      }}
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
      {/* Step 1: the source, what stays out, and the two devices that
          will hold the branch. The source half reads the device the
          page is scoped to. The device half re-pins to the landing
          device (DestinationScope), like the transplant's. */}
      {stage === "review" && (
        <PullReviewStep
          worktree={worktree}
          project={project}
          target={target}
          sourceDeviceLabel={sourceDeviceLabel}
          thisDeviceLabel={thisDeviceLabel}
          landing={landing}
          toPeer={toPeer}
          pull={pull}
          onCancel={onClose}
          onStart={start}
          heading="On both"
          sourceNote="keeps its copy"
          sourceKeeps
          idleNote={`Stop any time. Stopping removes the copy ${landing.on}.`}
          startLabel="Start mirroring"
        />
      )}
      {stage === "done" && mirror.data && (
        <RunnerScope runsHere={toPeer !== undefined}>
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
        </RunnerScope>
      )}
    </PullFlowFrame>
  );
}

// The scope of the device running the session, the original's: this
// machine for a flow to a peer, and for a flow here the source peer
// the dialog is already scoped to.
function RunnerScope({
  runsHere,
  children,
}: {
  runsHere: boolean;
  children: ReactNode;
}) {
  return runsHere ? <LocalHostScope>{children}</LocalHostScope> : children;
}

// Step 3: the copy has landed and the session is up. Read under the
// runner's scope (RunnerScope): the session is that device's fact.
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
                  <StatusDot
                    tone={view?.tone ?? "sky"}
                    label={view?.label ?? "opening"}
                  />
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
