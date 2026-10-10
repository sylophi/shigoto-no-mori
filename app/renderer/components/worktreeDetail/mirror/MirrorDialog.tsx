// The mirror flow, the transplant dialog's sibling on the same frame:
// three steps on one rail. Review shows the source, both devices, and
// what stays out (the one choice a mirror has). Mirror is the move (a
// send from the original's device) with its progress frames, plus the
// session open on top. Live is
// proof: the session's first verdict, and for a copy here the way to
// its page.
// The flow runs both ways: MirrorDialog copies a peer's worktree here,
// MirrorToDialog copies one of this device's to a peer (under that
// peer's DestinationProvider). Either way the session runs on the
// device holding the original: the peer this dialog is scoped to for
// MirrorDialog, which sends the copy here, this device for
// MirrorToDialog. Its Mirror button sits on both worktrees' pages. A
// primary checkout takes the same flow, its copy on a branch of its
// own (contracts/git/branches.ts), which the words below say when the
// two names differ.
import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { pullLandingBranch } from "@shigomori/contracts/git/branches";
import type { MirrorSession } from "@shigomori/contracts/modules/mirror";
import type { Project, Worktree } from "@shigomori/contracts/schemas";
import { useLocalDeviceName } from "@/hooks/account/useAccount";
import {
  DestinationProvider,
  LocalHostScope,
} from "@/hooks/remote/useHostScope";
import { useMirrors, useStartMirror } from "@/hooks/remote/useMirrors";
import type { MoveMutation } from "@/hooks/remote/useMoveWorktree";
import { PullFlowFrame, usePullFlow } from "../flow/PullFlow";
import { LandedPath } from "../flow/FlowChrome";
import { usePeerDestination } from "../flow/peerTargets";
import type { DestinationPick, PeerTarget } from "../flow/PullReviewView";
import {
  type FlowStage,
  type Landing,
  LANDS_HERE,
  stepHeadline,
} from "../flow/pullSteps";
import { selectionSummary, sessionSummary } from "../flow/ignoreChoice";
import { describeMirror } from "./mirrorStatus";
import { MirrorHeadlineView, MirrorLiveView } from "./MirrorDialogView";
import { MirrorReview } from "./MirrorReview";

const STEPS = ["Review", "Mirror", "Live"] as const;

const TITLES: Record<FlowStage, string> = {
  review: "Mirror worktree",
  running: "Mirroring",
  failed: "Mirror didn't start",
  cancelled: "Mirror cancelled",
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
  mirror: MoveMutation<{
    worktree: Worktree;
    captured: boolean;
    dirtyApplied: boolean;
    session: string;
  }>;
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
  // Leaving a live mirror here, by any way out, opens the copy: the
  // peer's page this opened on folds into it in the sidebar, and what
  // it launches runs on the peer. A mirror to a peer opened on this
  // device's original, which stays.
  const finish = stage === "done" && toPeer === undefined ? open : onClose;

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
            title: "Match the files and open the mirror",
            detail: summary ?? "both ways",
          },
        ],
        // The header carries the outcome. The footer is left to its
        // buttons, bar the one thing the header does not say.
        sourcePart: "source",
        progressLabel: "Mirror progress",
        runningNote: "",
        failedNote: "Nothing was left behind, so trying again starts clean.",
        cancelledNote: "",
      }}
      onClose={finish}
      headline={
        <MirrorHeadlineView
          stage={stage}
          branch={worktree.branch}
          landingBranch={landingBranch}
          sourceDeviceLabel={sourceDeviceLabel}
          on={landing.on}
          running={
            progress.frame === null
              ? landing.onPeer
                ? `Reaching ${thisDeviceLabel}.`
                : "Reaching the source."
              : progress.frame.step === "apply" && !mirror.isSuccess
                ? "Opening the mirror."
                : `${stepHeadline(progress.frame, sourceDeviceLabel, landing)}.`
          }
        />
      }
    >
      {/* Step 1: the shared review (flow/PullReview.tsx), the original
          beside the copy. */}
      {stage === "review" && (
        <MirrorReview
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
            dirtyApplied={!mirror.data.captured || mirror.data.dirtyApplied}
            onDone={finish}
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
  ...props
}: {
  session: string;
  landed: Worktree;
  branch: string;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
  dirtyApplied: boolean;
  onDone: () => void;
}) {
  const { sessions } = useMirrors();
  const live: MirrorSession | undefined = sessions.find(
    (entry) => entry.session === session,
  );
  return (
    <MirrorLiveView
      {...props}
      path={<LandedPath path={landed.path} />}
      status={live === undefined ? null : describeMirror(live)}
      summary={live === undefined ? null : sessionSummary(live)}
    />
  );
}
