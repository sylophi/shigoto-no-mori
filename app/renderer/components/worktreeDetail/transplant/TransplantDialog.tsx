// The transplant flow, shaped after the owner's remote-ops mockups and
// honest to the backend: three steps on one rail. Review lists what
// travels and where it lands. Transplant is the pull with its progress
// frames read into four named steps. Finish up source shows the landed
// worktree and asks what happens to the copy on the source device
// (keep, shelve, or tear down). The move is the pull mutation: the
// last step is the report, and the mutation's own status is the
// stage. The flow runs both ways: TransplantDialog brings a peer's
// worktree here (the pull), TransplantToDialog sends one of this
// device's to a peer (the send, under that peer's DestinationProvider),
// both through the one move mutation (hooks/remote/useMoveWorktree.ts).
import { ArrowRight } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import {
  pullBringsIgnoredFiles,
  type SyncPullWorktreeResult,
  type SyncTeardownSourceResult,
} from "@shared/ipc/modules/sync";
import type { Project, Worktree } from "@shared/schemas";
import { useLocalDeviceName } from "@/hooks/account/useAccount";
import {
  type Move,
  type MoveMutation,
  useMoveWorktree,
  useTeardownSource,
} from "@/hooks/remote/useMoveWorktree";
import { DestinationProvider } from "@/hooks/remote/useHostScope";
import { modeOf, selectionSummary } from "../flow/ignoreChoice";
import { type FlowStage, PullFlowFrame, usePullFlow } from "../flow/PullFlow";
import type { DestinationPick } from "../flow/PullReview";
import { type PeerTarget, usePeerDestination } from "../flow/peerTargets";
import { TransplantFinish } from "./TransplantFinish";
import { TransplantReview } from "./TransplantReview";
import { type Landing, LANDS_HERE, stepHeadline } from "../flow/pullSteps";

const STEPS = [
  "Review & destination",
  "Transplant",
  "Finish up source",
] as const;

const TITLES: Record<FlowStage, string> = {
  review: "Transplant worktree",
  running: "Transplanting",
  failed: "Transplant stopped",
  cancelled: "Transplant cancelled",
  done: "Transplant complete",
};

export function TransplantDialog({
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
  // The identity-matched project on this machine the worktree lands in.
  // Absent when this machine has none: the pull clones the repo here
  // first, where the review says (flow/cloneDestination.tsx).
  localProject: Project | undefined;
  sourceDeviceLabel: string;
  onClose: () => void;
}) {
  const move: Move = {
    direction: "pull",
    source: { worktree, sourceProjectId: project.id, sourceIdentity },
  };
  const pull = useMoveWorktree(move);
  const teardown = useTeardownSource(move);
  const thisDeviceLabel = useLocalDeviceName();
  return (
    <TransplantFlow
      worktree={worktree}
      project={project}
      sourceIdentity={sourceIdentity}
      localProject={localProject}
      sourceDeviceLabel={sourceDeviceLabel}
      thisDeviceLabel={thisDeviceLabel}
      pull={pull}
      teardown={teardown}
      onClose={onClose}
    />
  );
}

// The same flow the other way: one of THIS device's worktrees, moved
// to a peer (which clones the repo first when it has no checkout). The
// page's scope is the source (this machine), and the destination's
// reads go to the picked peer.
export function TransplantToDialog({
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
  const move: Move = {
    direction: "send",
    worktree,
    targetDeviceId: picked?.deviceId,
  };
  const send = useMoveWorktree(move);
  const teardown = useTeardownSource(move);
  return (
    <DestinationProvider peer={picked}>
      <TransplantFlow
        worktree={worktree}
        project={project}
        sourceIdentity={sourceIdentity}
        {...flow}
        pull={send}
        teardown={teardown}
        onClose={onClose}
      />
    </DestinationProvider>
  );
}

function TransplantFlow({
  worktree,
  project,
  sourceIdentity,
  localProject,
  sourceDeviceLabel,
  thisDeviceLabel,
  landing = LANDS_HERE,
  toPeer,
  pull,
  teardown,
  onClose,
}: {
  worktree: Worktree;
  project: Project;
  sourceIdentity: string;
  // The landing side, named as the flow's pieces name it
  // (flow/PullReview.tsx says why): this machine, or the picked peer.
  // Absent on the review of a flow to a peer with none picked yet,
  // which Start waits on, and on a flow here with no checkout of the
  // repo, which the pull clones first (flow/cloneDestination.tsx).
  localProject: Project | undefined;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
  // A flow to a peer: the words for landing there, and the pick of
  // which peer (flow/peerTargets.ts makes both).
  landing?: Landing;
  toPeer?: DestinationPick;
  pull: MoveMutation<SyncPullWorktreeResult>;
  teardown: UseMutationResult<SyncTeardownSourceResult, Error, void>;
  onClose: () => void;
}) {
  const flow = usePullFlow({
    mutation: pull,
    worktree,
    project,
    sourceIdentity,
    localProject,
    toPeer,
    onClose,
  });
  // The leave-out rule and the setup switch, the mirror's pair.
  const { stage, progress, start, open, pull: choice, target } = flow;
  const mode = modeOf(choice.selection);
  const bringsFiles = pullBringsIgnoredFiles(mode);

  return (
    <PullFlowFrame
      flow={flow}
      worktree={worktree}
      reviewIcon={ArrowRight}
      titles={TITLES}
      sourceDeviceLabel={sourceDeviceLabel}
      thisDeviceLabel={thisDeviceLabel}
      landing={landing}
      steps={STEPS}
      stepsLabel="Transplant steps"
      progressExtras={{
        failedNote: landing.onPeer
          ? `The copy here is untouched. If the worktree already landed ${landing.on}, open it from the sidebar instead of retrying.`
          : undefined,
        cancelledNote: landing.onPeer
          ? `Nothing landed ${landing.on}, and the copy here is untouched.`
          : undefined,
        filesDetail: bringsFiles
          ? (selectionSummary(choice.selection) ?? "everything ignored, too")
          : undefined,
      }}
      onClose={onClose}
      headline={
        <>
          {stage === "review" && (
            <>
              Move <span className="font-mono">{worktree.branch}</span>{" "}
              {landing.onPeer ? landing.to : `off ${sourceDeviceLabel}`},
              uncommitted work included.
            </>
          )}
          {stage === "running" &&
            `${stepHeadline(progress.frame, sourceDeviceLabel, landing)}.`}
          {stage === "failed" && `Nothing on ${sourceDeviceLabel} changed.`}
          {stage === "cancelled" &&
            `Stopped where you asked. Nothing on ${sourceDeviceLabel} changed.`}
          {stage === "done" && (
            <>
              <span className="font-mono">{worktree.branch}</span> now lives on{" "}
              {thisDeviceLabel}. What about the copy on {sourceDeviceLabel}?
            </>
          )}
        </>
      }
    >
      {stage === "review" && (
        <TransplantReview
          worktree={worktree}
          project={project}
          target={target}
          sourceDeviceLabel={sourceDeviceLabel}
          thisDeviceLabel={thisDeviceLabel}
          landing={landing}
          toPeer={toPeer}
          pull={choice}
          onCancel={onClose}
          onStart={start}
        />
      )}
      {stage === "done" && pull.data && (
        <TransplantFinish
          result={pull.data}
          leftOutCount={
            mode === "custom"
              ? choice.selection.leftOut.size
              : mode === "everything"
                ? 0
                : null
          }
          worktree={worktree}
          project={project}
          sourceDeviceLabel={sourceDeviceLabel}
          thisDeviceLabel={thisDeviceLabel}
          landing={landing}
          teardown={teardown}
          onClose={onClose}
          onOpen={open}
        />
      )}
    </PullFlowFrame>
  );
}
