// The review step's pieces the transplant and the mirror both wear: the
// source card, the devices column, the destination folder, the
// collision check and the footer band. Each flow's own review composes
// them around what only it shows. The destination is this machine
// unless the flow is a transplant to a peer (DestinationScope), so
// `localProject` and `thisDeviceLabel` name the landing side, whichever
// machine that is. What each piece reads is here, and how it looks is
// PullReviewView.tsx.
import type { ReactNode } from "react";
import type { Project, Worktree } from "@shared/schemas";
import { pullLandingCollision } from "@shared/pullCollision";
import { useWorktreeBaseLabel } from "@/hooks/config/useWorktreeBaseLabel";
import { useBranches } from "@/hooks/git/useBranches";
import {
  DestinationScope,
  useDestinationScope,
  useHostScope,
} from "@/hooks/remote/useHostScope";
import {
  useDeviceIcon,
  useRemoteDevice,
} from "@/hooks/remote/useRemoteDevices";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import {
  CloneDestinationSection,
  type LandingTarget,
} from "./cloneDestination";
import type { PullChoiceState } from "./ignoreChoice";
import { PullLeaveOut } from "./PullLeaveOut";
import {
  DestinationFolderView,
  DestinationRowView,
  PullReviewFooterView,
  PullReviewStepView,
  ReviewDevicesColumnView,
  SourceCardView,
} from "./PullReviewView";
import { SetupToggle } from "./SetupToggle";
import { isReadyTarget, type PeerTarget } from "./peerTargets";
import { type Landing, LANDS_HERE } from "./pullSteps";

// The destination's pick, for a flow to a peer: the devices that could
// take the worktree and the way to choose which one does. The picked
// one is the destination the rest of the column describes. Until one
// is picked there is no landing project, so the column is the rows
// alone and the footer holds Start.
export type DestinationPick = {
  targets: PeerTarget[];
  pickedId: string | null;
  onPick: (deviceId: string) => void;
};

// The landing device's side of the collision check
// (pullLandingCollision), over its cached lists. Read under
// DestinationScope. Both lists are the ordinary cached ones, so the
// row and the footer asking the same question cost one read between
// them.
function useLocalCollision(
  localProject: Project | undefined,
  worktree: Worktree,
  landing: Landing = LANDS_HERE,
) {
  const { data: branches } = useBranches(localProject?.id ?? null);
  const { data: worktrees } = useWorktrees(localProject?.id ?? null);
  return pullLandingCollision({
    worktree,
    projectName: localProject?.name,
    localBranches: branches?.local,
    worktrees,
    // A peer's refusal names the peer.
    where: landing.onPeer ? landing.on : undefined,
  });
}

// The landing device, filled (DestinationRowView), with its device and
// its side of the collision check.
function DestinationRow({
  worktree,
  target,
  thisDeviceLabel,
  toPeer,
}: {
  worktree: Worktree;
  target: LandingTarget;
  thisDeviceLabel: string;
  toPeer: boolean;
}) {
  // The destination as the devices column names it: this machine, or
  // the peer a flow to a peer picked (DestinationProvider).
  const destinationIcon = useDeviceIcon(useDestinationScope().deviceId);
  const { landingBranch, held, holder } = useLocalCollision(
    target.project,
    worktree,
  );
  return (
    <DestinationRowView
      worktree={worktree}
      icon={destinationIcon}
      thisDeviceLabel={thisDeviceLabel}
      landing={
        target.project
          ? { has: target.project.name }
          : { gets: target.clone.projectName }
      }
      collision={{ landingBranch, held, holderName: holder?.name }}
      toPeer={toPeer}
    />
  );
}

// The review step's right-hand column, the transplant's and the
// mirror's (ReviewDevicesColumnView): the two devices, the folder it
// lands in, and the setup switch. Read under the destination's scope,
// since every fact in it is that machine's.
export function ReviewDevicesColumn({
  heading,
  sourceNote,
  sourceKeeps = false,
  toPeer,
  worktree,
  projectName,
  target,
  sourceDeviceLabel,
  thisDeviceLabel,
  pull,
}: {
  heading: string;
  sourceNote: string;
  sourceKeeps?: boolean;
  toPeer?: DestinationPick;
  worktree: Worktree;
  // The source's project, for the rows of devices that would clone it.
  projectName: string;
  // Where the flow lands (flow/cloneDestination.tsx). Null while a
  // flow to a peer has no destination picked.
  target: LandingTarget | null;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
  pull: PullChoiceState;
}) {
  // The source is the device the dialog sits under.
  const sourceIcon = useDeviceIcon(useHostScope().deviceId);
  return (
    <DestinationScope>
      <ReviewDevicesColumnView
        heading={heading}
        sourceNote={sourceNote}
        sourceKeeps={sourceKeeps}
        toPeer={
          toPeer && {
            targets: toPeer.targets.map((candidate) => ({
              ...candidate,
              ready: isReadyTarget(candidate),
            })),
            pickedId: toPeer.pickedId,
            onPick: toPeer.onPick,
          }
        }
        projectName={projectName}
        destination={
          target !== null && (
            <DestinationRow
              worktree={worktree}
              target={target}
              thisDeviceLabel={thisDeviceLabel}
              toPeer={toPeer !== undefined}
            />
          )
        }
        sourceIcon={sourceIcon}
        sourceDeviceLabel={sourceDeviceLabel}
      >
        {target?.project && (
          <>
            <DestinationFolder
              localProject={target.project}
              thisDeviceLabel={thisDeviceLabel}
              worktree={worktree}
            />

            <SetupToggle
              localProject={target.project}
              thisDeviceLabel={thisDeviceLabel}
              checked={pull.runSetup}
              onChange={pull.setRunSetup}
            />
          </>
        )}
        {target?.clone && (
          <CloneDestinationSection
            clone={target.clone}
            thisDeviceLabel={thisDeviceLabel}
          />
        )}
      </ReviewDevicesColumnView>
    </DestinationScope>
  );
}

// The review step's footer band (PullReviewFooterView), with the
// collision refusal it reads on the landing device.
export function PullReviewFooter({
  worktree,
  target,
  landing,
  waiting,
  blocked,
  idleNote,
  startLabel,
  onCancel,
  onStart,
}: {
  worktree: Worktree;
  // Where the flow lands, null while unpicked. A clone has no project
  // to check for collisions in yet.
  target: LandingTarget | null;
  landing?: Landing;
  // The gitignored rule resolves over the ignored list: no start
  // before it lands, or the files step would bring everything.
  waiting: boolean;
  // The wait's reason when it will not end on its own.
  blocked: string | null;
  idleNote: string;
  startLabel: string;
  onCancel: () => void;
  onStart: () => void;
}) {
  const { refusal } = useLocalCollision(target?.project, worktree, landing);
  return (
    <PullReviewFooterView
      refusal={refusal}
      unpicked={target === null}
      waiting={waiting}
      blocked={blocked}
      idleNote={idleNote}
      startLabel={startLabel}
      onCancel={onCancel}
      onStart={onStart}
    />
  );
}

// What a flow's review step takes, the transplant's and the mirror's.
export type PullReviewProps = {
  worktree: Worktree;
  project: Project;
  // Where it lands (flow/cloneDestination.tsx): this machine's
  // project or the clone that makes one, or the picked peer's when the
  // flow goes to one (`toPeer`), null until one is picked.
  target: LandingTarget | null;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
  landing?: Landing;
  toPeer?: DestinationPick;
  // The leave-out rule and the setup switch, the flows' shared pair.
  pull: PullChoiceState;
  onCancel: () => void;
  onStart: () => void;
};

// Step 1 of either flow: the source, what stays out, and the two
// devices that will hold the branch, with the footer band under them.
// The source half reads the device the page is scoped to. The device
// half and the footer re-pin to the landing device (DestinationScope).
// A flow's own sections go before or after the leave-out rule.
export function PullReviewStep({
  worktree,
  project,
  target,
  sourceDeviceLabel,
  thisDeviceLabel,
  landing,
  toPeer,
  pull,
  onCancel,
  onStart,
  heading,
  sourceNote,
  sourceKeeps,
  idleNote,
  startLabel,
  beforeLeaveOut,
  afterLeaveOut,
}: PullReviewProps & {
  // The devices column's heading and the source row's note (and tick).
  heading: string;
  sourceNote: string;
  sourceKeeps?: boolean;
  // The footer's reassurance and its start button.
  idleNote: string;
  startLabel: string;
  beforeLeaveOut?: ReactNode;
  afterLeaveOut?: ReactNode;
}) {
  return (
    <PullReviewStepView
      source={
        <SourceCard
          worktree={worktree}
          project={project}
          sourceDeviceLabel={sourceDeviceLabel}
        />
      }
      beforeLeaveOut={beforeLeaveOut}
      leaveOut={
        <PullLeaveOut
          pull={pull}
          worktree={{
            projectId: project.id,
            id: worktree.id,
            path: worktree.path,
          }}
        />
      }
      afterLeaveOut={afterLeaveOut}
      devices={
        <ReviewDevicesColumn
          heading={heading}
          sourceNote={sourceNote}
          sourceKeeps={sourceKeeps}
          toPeer={toPeer}
          worktree={worktree}
          projectName={project.name}
          target={target}
          sourceDeviceLabel={sourceDeviceLabel}
          thisDeviceLabel={thisDeviceLabel}
          pull={pull}
        />
      }
      footer={
        <DestinationScope>
          <PullReviewFooter
            worktree={worktree}
            target={target}
            landing={landing}
            waiting={pull.waiting}
            blocked={pull.blocked}
            idleNote={idleNote}
            startLabel={startLabel}
            onCancel={onCancel}
            onStart={onStart}
          />
        </DestinationScope>
      }
    />
  );
}

export function SourceCard({
  worktree,
  project,
  sourceDeviceLabel,
}: {
  worktree: Worktree;
  project: Project;
  sourceDeviceLabel: string;
}) {
  const { deviceId } = useHostScope();
  const device = useRemoteDevice(deviceId);
  const icon = useDeviceIcon(deviceId);
  // The card sits in the source device's scope, so this is the PEER's
  // home, and a transplant already holds the grant that read needs.
  // Refused or not yet answered, the path shows as it is.
  const { data: runtime } = useRuntimeInfo();
  const { data: pr, isPending: prPending } = useWorktreePullRequest(
    project.id,
    worktree.branch,
  );
  return (
    <SourceCardView
      worktree={worktree}
      project={project}
      sourceDeviceLabel={sourceDeviceLabel}
      icon={icon}
      status={device ? deviceStatusView(device.status) : null}
      home={runtime?.homedir ?? null}
      pr={pr}
      prPending={prPending}
    />
  );
}

// Where the worktree lands (DestinationFolderView): under the local
// layout's base folder.
function DestinationFolder({
  localProject,
  thisDeviceLabel,
  worktree,
}: {
  localProject: Project;
  thisDeviceLabel: string;
  worktree: Worktree;
}) {
  return (
    <DestinationFolderView
      thisDeviceLabel={thisDeviceLabel}
      base={useWorktreeBaseLabel(localProject)}
      worktree={worktree}
    />
  );
}
