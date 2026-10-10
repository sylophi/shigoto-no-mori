// The review step the transplant and the mirror both wear: the source
// card, the destination card (with the pick of a peer and the setup
// switch), the collision check and the footer band. Each flow's own review composes
// them around what only it shows. The destination is this machine
// unless the flow is a transplant to a peer (DestinationScope), so
// `localProject` and `thisDeviceLabel` name the landing side, whichever
// machine that is.
import { type ReactNode, useState } from "react";
import type { Project, Worktree } from "@shigomori/contracts/schemas";
import {
  pullBranchCollision,
  pullFolderCollision,
} from "@shared/pullCollision";
import {
  pullLandingBranch,
  pullWorktreeName,
} from "@shigomori/contracts/git/branches";
import { FolderPickerModal } from "@/components/shared/FolderPickerModal";
import { useWorktreeBaseLabel } from "@/hooks/config/useWorktreeBaseLabel";
import { useBranches } from "@/hooks/git/useBranches";
import {
  DestinationScope,
  useDestinationScope,
  useHostScope,
} from "@/hooks/remote/useHostScope";
import { useDeviceIcon } from "@/hooks/remote/useRemoteDevices";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import { worktreeTitle } from "@shigomori/ui/lib/worktreeTitle.ts";
import type { LandingTarget } from "@shigomori/ui/views/worktreeDetail/flow/pullSteps.ts";
import { useCreatePlan } from "./createPlan";
import type { PullChoiceState } from "./ignoreChoice";
import { PullLeaveOut } from "./PullLeaveOut";
import {
  CloneLinesView,
  type DestinationPick,
  DestinationCardView,
  LandingLinesView,
  PullReviewFooterView,
  PullReviewStepView,
  SetupRowView,
  SourceCardView,
} from "@shigomori/ui/views/worktreeDetail/flow/PullReviewView.tsx";
import {
  type Landing,
  LANDS_HERE,
} from "@shigomori/ui/views/worktreeDetail/flow/pullSteps.ts";

// Where the pull would refuse at step 2 (host/ipc/modules/sync.ts
// runPullWorktree): the landing device already has the branch, checked
// out in a worktree or merely existing, or already has a worktree
// under the folder name the copy would take. Read under
// DestinationScope. Both lists are the ordinary cached ones, so the
// row and the footer asking the same question cost one read between
// them. The disk half of the folder rule (a stray folder that is no
// worktree) is the host's alone. With no landing project yet (a flow
// to a peer before its pick) nothing is read and nothing refuses. The
// branch asked about is the one the copy lands on (pullLandingBranch).
function useLocalCollision(
  localProject: Project | undefined,
  worktree: Worktree,
  landing: Landing = LANDS_HERE,
): {
  // The branch the copy lands on.
  landingBranch: string;
  // The refusal the footer shows and Start waits on, or null.
  refusal: string | null;
} {
  const { data: branches } = useBranches(localProject?.id ?? null);
  const { data: worktrees } = useWorktrees(localProject?.id ?? null);
  const landingBranch = pullLandingBranch(worktree);
  const held = branches?.local.includes(landingBranch) ?? false;
  const holder = held
    ? worktrees?.find((entry) => entry.branch === landingBranch)
    : undefined;
  const name = pullWorktreeName(worktree);
  const taken =
    name !== undefined &&
    (worktrees?.some(
      (entry) => entry.name.toLowerCase() === name.toLowerCase(),
    ) ??
      false);
  // A peer's refusal names the peer. This device's keeps its own words.
  const where = landing.onPeer ? landing.on : undefined;
  const refusal =
    localProject === undefined
      ? null
      : held
        ? pullBranchCollision(landingBranch, holder?.path, where)
        : taken
          ? pullFolderCollision(name, `${localProject.name}/${name}`, where)
          : null;
  return { landingBranch, refusal };
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

// Either flow's review step (PullReviewStepView). The source half
// reads the device the page is scoped to, the destination half and the
// footer re-pin to the landing device (DestinationScope).
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
  link,
  sourceHeading,
  destinationHeading,
  idleNote,
  startLabel,
  details,
}: PullReviewProps & {
  link: "move" | "mirror";
  // The two cards' headings, in the flow's words.
  sourceHeading: string;
  destinationHeading: string;
  // The footer's reassurance, "" for none, and its start button.
  idleNote: string;
  startLabel: string;
  details?: ReactNode;
}) {
  // What the work is called, read here in the source's scope: the copy
  // carries the title over, so both cards lead with it.
  const { data: pr } = useWorktreePullRequest(project.id, worktree.branch);
  const title = worktreeTitle(worktree, pr);
  return (
    <PullReviewStepView
      link={link}
      source={
        <SourceCard
          heading={sourceHeading}
          title={title}
          pr={pr}
          worktree={worktree}
          project={project}
          sourceDeviceLabel={sourceDeviceLabel}
        />
      }
      destination={
        <DestinationScope>
          <DestinationCard
            heading={destinationHeading}
            title={title}
            worktree={worktree}
            target={target}
            deviceLabel={thisDeviceLabel}
            landing={landing ?? LANDS_HERE}
            toPeer={toPeer}
            pull={pull}
          />
        </DestinationScope>
      }
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
      details={details}
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

function PullReviewFooter({
  worktree,
  target,
  landing,
  ...props
}: {
  worktree: Worktree;
  // Where the flow lands, null while unpicked. A clone has no project
  // to check for collisions in yet.
  target: LandingTarget | null;
  landing?: Landing;
  waiting: boolean;
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
      {...props}
    />
  );
}

function SourceCard({
  project,
  ...props
}: Omit<
  Parameters<typeof SourceCardView>[0],
  "projectName" | "icon" | "home"
> & { project: Project }) {
  const { deviceId } = useHostScope();
  // The card sits in the source device's scope, so this is the PEER's
  // home, and a transplant already holds the grant that read needs.
  const { data: runtime } = useRuntimeInfo();
  return (
    <SourceCardView
      {...props}
      projectName={project.name}
      icon={useDeviceIcon(deviceId)}
      home={runtime?.homedir ?? null}
    />
  );
}

function DestinationCard({
  heading,
  title,
  worktree,
  target,
  deviceLabel,
  landing,
  toPeer,
  pull,
}: {
  heading: string;
  title: string | null;
  worktree: Worktree;
  target: LandingTarget | null;
  deviceLabel: string;
  landing: Landing;
  toPeer: DestinationPick | undefined;
  pull: PullChoiceState;
}) {
  const { deviceId } = useDestinationScope();
  return (
    <DestinationCardView
      heading={heading}
      icon={useDeviceIcon(deviceId)}
      deviceLabel={deviceLabel}
      target={target}
      toPeer={toPeer}
      setup={
        target?.project && (
          <SetupRow
            localProject={target.project}
            checked={pull.runSetup}
            onChange={pull.setRunSetup}
          />
        )
      }
      lines={
        target === null ? null : target.project ? (
          <LandingLines
            title={title}
            worktree={worktree}
            project={target.project}
            landing={landing}
          />
        ) : (
          <CloneLines clone={target.clone} title={title} worktree={worktree} />
        )
      }
    />
  );
}

// A project without a setup script has no row.
function SetupRow({
  localProject,
  ...props
}: {
  localProject: Project;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const command = useCreatePlan(localProject).setupCommand;
  if (command === "") return null;
  return <SetupRowView command={command} {...props} />;
}

function LandingLines({
  title,
  worktree,
  project,
  landing,
}: {
  title: string | null;
  worktree: Worktree;
  project: Project;
  landing: Landing;
}) {
  const { landingBranch, refusal } = useLocalCollision(
    project,
    worktree,
    landing,
  );
  return (
    <LandingLinesView
      title={title}
      landingBranch={landingBranch}
      folder={pullWorktreeName(worktree)}
      refused={refusal !== null}
      base={useWorktreeBaseLabel(project)}
    />
  );
}

function CloneLines({
  clone,
  title,
  worktree,
}: {
  clone: NonNullable<LandingTarget["clone"]>;
  title: string | null;
  worktree: Worktree;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <CloneLinesView
      clone={clone}
      title={title}
      worktree={worktree}
      onChange={() => setPicking(true)}
      picker={
        picking && (
          <FolderPickerModal
            initialPath={clone.cloneInto.parentDir}
            title="Clone into"
            hint={`${clone.projectName} becomes a new folder inside the one you pick.`}
            onPick={(chosen) => {
              clone.setParent(chosen);
              setPicking(false);
            }}
            onClose={() => setPicking(false)}
          />
        )
      }
    />
  );
}
