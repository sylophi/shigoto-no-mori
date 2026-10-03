// The transplant dialog at its review step, as "Transplant to..." opens
// it on brave-badger (fix-stale-locks on the Studio Mac): bound for the
// Thinkpad, the one peer that is connected, with Mini and Work PC
// listed off. The dialog's box alone, at the live one's width. The
// live dialog (TransplantDialog, TransplantReview, PullReviewStep)
// puts the same views together, each read from the app.
import { ArrowRight } from "lucide-react";
import {
  PULL_FLOW_POPOVER,
  PullFlowFrameView,
} from "@/components/worktreeDetail/flow/PullFlowFrameView";
import { LeaveOutPickerView } from "@/components/worktreeDetail/flow/LeaveOutPickerView";
import {
  DestinationFolderView,
  DestinationRowView,
  PullReviewFooterView,
  PullReviewStepView,
  ReviewDevicesColumnView,
  SourceCardView,
} from "@/components/worktreeDetail/flow/PullReviewView";
import { landsOnPeer } from "@/components/worktreeDetail/flow/pullSteps";
import { SetupToggleView } from "@/components/worktreeDetail/flow/SetupToggleView";
import {
  TRANSPLANT_REVIEW,
  TRANSPLANT_STEPS,
  TRANSPLANT_STEPS_LABEL,
  TRANSPLANT_TITLES,
  TransplantReviewHeadline,
} from "@/components/worktreeDetail/transplant/transplantCopy";
import {
  CarryOverListView,
  UncommittedChangesView,
} from "@/components/worktreeDetail/transplant/TransplantReviewView";
import { ModalShellBox } from "@/components/ui/modal-shell-view";
import { selectionOfPreset, setupDefaultFor } from "@shared/leaveOutRule";
import { parseLeaveOutPreset } from "@shared/sharedSettings";
import { BRAVE_BADGER_ID, THINKPAD_ID } from "../fixtures";
import {
  deviceById,
  deviceIconOf,
  homeOf,
  pullRequestOf,
  worktreeById,
} from "./world";
import { landingOn, peerTargetsOf } from "./world/transplant";

// A picture takes no clicks.
const noop = () => {};

export function TransplantScene() {
  const { worktree, project, deviceId } = worktreeById(BRAVE_BADGER_ID);
  const source = deviceById(deviceId);
  const destination = deviceById(THINKPAD_ID);
  const landing = landsOnPeer(destination.name);
  const landed = landingOn(THINKPAD_ID, project, worktree, landing);
  const { held, holder, landingBranch, refusal } = landed.collision;
  // The rule the dialog opens on: the project's preset, none set in
  // the lab.
  const selection = selectionOfPreset(parseLeaveOutPreset(undefined));
  return (
    <div data-slot="transplant-dialog" className="w-4xl">
      <ModalShellBox popoverClassName={PULL_FLOW_POPOVER}>
        <PullFlowFrameView
          stage="review"
          reviewIcon={ArrowRight}
          titles={TRANSPLANT_TITLES}
          thisDeviceLabel={destination.name}
          elapsed={0}
          steps={TRANSPLANT_STEPS}
          stepsLabel={TRANSPLANT_STEPS_LABEL}
          headline={
            <TransplantReviewHeadline
              branch={worktree.branch}
              landing={landing}
              sourceDeviceLabel={source.name}
            />
          }
          onClose={noop}
        >
          <PullReviewStepView
            source={
              <SourceCardView
                worktree={worktree}
                project={project}
                sourceDeviceLabel={source.name}
                icon={deviceIconOf(source)}
                // This device's own card names no status.
                status={null}
                home={homeOf(deviceId)}
                pr={pullRequestOf(project.id, worktree.branch).pr ?? null}
                prPending={false}
              />
            }
            beforeLeaveOut={
              <UncommittedChangesView dirty={worktree.changedCount > 0} />
            }
            leaveOut={
              <LeaveOutPickerView
                value={selection}
                onChange={noop}
                ignored={{ data: undefined, isPending: false, isError: false }}
                onAdd={noop}
              />
            }
            afterLeaveOut={
              <CarryOverListView
                projectName={landed.project.name}
                thisDeviceLabel={destination.name}
                rows={landed.carryOver}
                isPending={false}
              />
            }
            devices={
              <ReviewDevicesColumnView
                heading={TRANSPLANT_REVIEW.heading}
                sourceNote={TRANSPLANT_REVIEW.sourceNote}
                toPeer={{
                  targets: peerTargetsOf(project, deviceId),
                  pickedId: THINKPAD_ID,
                  onPick: noop,
                }}
                projectName={project.name}
                destination={
                  <DestinationRowView
                    worktree={worktree}
                    icon={deviceIconOf(destination)}
                    thisDeviceLabel={destination.name}
                    landing={{ has: landed.project.name }}
                    collision={{
                      landingBranch,
                      held,
                      holderName: holder?.name,
                    }}
                    toPeer
                  />
                }
                sourceIcon={deviceIconOf(source)}
                sourceDeviceLabel={source.name}
              >
                <DestinationFolderView
                  thisDeviceLabel={destination.name}
                  base={landed.folderBase}
                  worktree={worktree}
                />
                <SetupToggleView
                  thisDeviceLabel={destination.name}
                  command={landed.setupCommand}
                  checked={setupDefaultFor(selection)}
                  onChange={noop}
                />
              </ReviewDevicesColumnView>
            }
            footer={
              <PullReviewFooterView
                refusal={refusal}
                unpicked={false}
                waiting={false}
                blocked={null}
                idleNote={TRANSPLANT_REVIEW.idleNote(source.name)}
                startLabel={TRANSPLANT_REVIEW.startLabel}
                onCancel={noop}
                onStart={noop}
              />
            }
          />
        </PullFlowFrameView>
      </ModalShellBox>
    </div>
  );
}
