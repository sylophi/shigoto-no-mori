// The transplant dialog's data (../TransplantScene.tsx): a local
// worktree sent to a peer, as "Transplant to..." opens it.
import type { PeerTargetRowData } from "@/components/worktreeDetail/flow/PullReviewView";
import type { Landing } from "@/components/worktreeDetail/flow/pullSteps";
import { lifecycleCommand } from "@/components/worktreeDetail/scripts/lifecycleRows";
import { carryOverItems } from "@/lib/carryOverPaths";
import { worktreeBaseLabel } from "@shared/git/worktreeLayout";
import { pullLandingCollision } from "@shared/pullCollision";
import type { Project, Worktree } from "@shared/schemas";
import {
  accountDevices,
  forests,
  labGlobalConfig,
  labLocalBranches,
  labShigomoriConfig,
} from "../../fixtures";
import { deviceIconOf, homeOf } from "./index";

// A device's checkout of a repo, by the identity every checkout shares.
function checkoutOn(deviceId: string, project: Project): Project | undefined {
  if (project.identity == null) return undefined;
  return forests[deviceId]?.projects.find(
    (candidate) => candidate.identity === project.identity,
  );
}

// The devices a local worktree could go to, as the review's column
// lists them (flow/peerTargets.ts): every other device of the account,
// in the account's order. An online one is reachable with its checkout
// of the repo, and one asleep is listed off with its checkout unknown,
// as the lab's default pose has Mini and Work PC.
export function peerTargetsOf(
  project: Project,
  localDeviceId: string,
): PeerTargetRowData[] {
  return accountDevices
    .filter((device) => device.deviceId !== localDeviceId)
    .map((device) => ({
      deviceId: device.deviceId,
      label: device.name,
      icon: deviceIconOf(device),
      project: device.online ? checkoutOn(device.deviceId, project) : undefined,
      block: device.online ? undefined : ("offline" as const),
      ready: device.online,
    }));
}

// What the review reads on the device a worktree lands on: its checkout
// of the repo, whether the copy collides with anything there, the
// project's carry-over, where its worktrees go and its setup script.
// The lab's projects share one config (labShigomoriConfig), which
// names no layout, so worktrees land under the managed root in the
// device's data dir (lab/bridge.ts runtime:info).
export function landingOn(
  deviceId: string,
  project: Project,
  worktree: Worktree,
  landing: Landing,
) {
  const landingProject = checkoutOn(deviceId, project);
  const forest = forests[deviceId];
  if (!landingProject || !forest) {
    throw new Error(`[scenes] ${deviceId} has no ${project.name}`);
  }
  const home = homeOf(deviceId);
  return {
    project: landingProject,
    collision: pullLandingCollision({
      worktree,
      projectName: landingProject.name,
      localBranches: labLocalBranches(forest),
      worktrees: forest.worktrees[landingProject.id] ?? [],
      where: landing.onPeer ? landing.on : undefined,
    }),
    // No .worktreeinclude in the lab's repos.
    carryOver: carryOverItems(labShigomoriConfig, null),
    folderBase: worktreeBaseLabel(labShigomoriConfig, landingProject.path, {
      dataDir: `${home}/.sm`,
      canonicalDataDirName: ".sm",
      onProjectDrive: labGlobalConfig.managedOnProjectDrive,
      homedir: home,
    }),
    setupCommand: lifecycleCommand(labShigomoriConfig.scripts, "setup"),
  };
}
