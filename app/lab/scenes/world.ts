// The lab's fixture world (../fixtures.ts) in the shapes the app's views
// take, for the scenes in this folder. Plain functions over plain data:
// a scene renders in Node (test/scenes.mts) and into the marketing site
// at build time, so nothing here may reach window, the router or a
// query.
import type { DevicesPageRow } from "@/components/remote/DevicesPageView";
import { deviceRowStatus } from "@/components/remote/deviceRegistryStatus";
import type { SidebarDeviceBadge } from "@/components/sidebar/DeviceBadgeView";
import type { WorktreeRowLook } from "@/components/sidebar/rowState";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { RemoteDeviceStatus } from "@/lib/remote/devices";
import type { DeviceInfo } from "@shared/hub/protocol";
import { pullRequestStackPosition } from "@shared/pullRequestStack";
import type { Project, PullRequest, Worktree } from "@shared/schemas";
import type { ComponentProps } from "react";
import { pullLandingBranch, pullWorktreeName } from "@shared/git/branches";
import { layoutInputsFor, worktreeBaseFor } from "@shared/git/worktreeLayout";
import { selectionOfPreset, setupDefaultFor } from "@shared/leaveOutRule";
import { tildify } from "@shared/projectPaths";
import {
  pullBranchCollision,
  pullFolderCollision,
} from "@shared/pullCollision";
import { parseLeaveOutPreset } from "@shared/sharedSettings";
import type {
  DestinationRowCollision,
  PeerTargetRowData,
} from "@/components/worktreeDetail/flow/PullReviewView";
import {
  type Landing,
  landsOnPeer,
} from "@/components/worktreeDetail/flow/pullSteps";
import type { TransplantDialogView } from "@/components/worktreeDetail/transplant/TransplantDialogView";
import {
  accountDevices,
  forests,
  labDisks,
  labGlobalConfig,
  labProjectConfig,
  projectIconFor,
} from "../fixtures";
import { labPullRequestsFor } from "../pullRequestFixtures";
import {
  LAB_APP_VERSION,
  LOCAL_DEVICE_ID,
  MINI_ID,
  THINKPAD_ID,
  WORKPC_ID,
} from "../fixtures";

// The moment the scenes are drawn at, which "14m ago" counts back from.
// The fixtures date themselves back from the same moment (their module
// loads alongside this one), so the relative times hold on every build.
export const NOW = Date.now();

// A row in no state worth naming: not open, nothing running.
export const QUIET_LOOK: WorktreeRowLook = {
  isSelected: false,
  activity: null,
  isDeleting: false,
  title: undefined,
};

// A worktree by id, with the project and device it belongs to.
export function worktreeById(id: string): {
  worktree: Worktree;
  project: Project;
  deviceId: string;
} {
  for (const forest of Object.values(forests)) {
    for (const [projectId, worktrees] of Object.entries(forest.worktrees)) {
      const worktree = worktrees.find((candidate) => candidate.id === id);
      const project = forest.projects.find((p) => p.id === projectId);
      if (worktree && project) {
        return { worktree, project, deviceId: forest.deviceId };
      }
    }
  }
  throw new Error(`[scenes] no worktree ${id} in the fixtures`);
}

// A peer's badge, as the sidebar wears it. Connected unless posed
// otherwise, as the lab's default peer is.
export function badgeOf(
  deviceId: string,
  status: RemoteDeviceStatus = {
    phase: "connected",
    remoteDeviceId: deviceId,
    remoteAppVersion: "2.0.3",
  },
): SidebarDeviceBadge {
  const device = accountDevices.find((d) => d.deviceId === deviceId);
  if (!device) throw new Error(`[scenes] no device ${deviceId}`);
  const { tone, reachable } = deviceStatusView(status);
  return {
    deviceId,
    label: device.name,
    icon: device.icon ?? "laptop",
    tone,
    reachable,
  };
}

// A project's logo as the views take it (ProjectIconView's `src`): the
// fixture's, or null for the generated tile.
export function iconSrcOf(name: string): string | null {
  const icon = projectIconFor(name);
  return icon ? `data:${icon.mime};base64,${icon.base64}` : null;
}

// A branch's pull request and its place in a stack, with the stack open
// or (merged) landed.
export function pullRequestOf(
  projectId: string,
  branch: string,
  merged = false,
): {
  pr: PullRequest | undefined;
  stack: ReturnType<typeof pullRequestStackPosition>;
} {
  const prs = labPullRequestsFor(projectId, merged) as Record<
    string,
    PullRequest
  >;
  return { pr: prs[branch], stack: pullRequestStackPosition(prs, branch) };
}

// The Devices page's rows as the desktop Studio Mac sees them, the way
// the lab poses it by default (lab/bridge.ts): this device online with
// its tunnel up, letting the others control it and staying reachable,
// the Thinkpad connected with its dev server forwarded, the Mini and
// the Work PC away since their last session.
export function devicesPageRows(): DevicesPageRow[] {
  const thisDevice = deviceById(LOCAL_DEVICE_ID);
  const thinkpad = deviceById(THINKPAD_ID);
  const away = (id: string): DevicesPageRow => {
    const device = deviceById(id);
    return {
      ...rowBasics(device),
      status: deviceRowStatus(device, false, undefined, null, NOW),
      appVersion: "",
      // No session, so the peer has not said whether it takes orders.
      access: { granted: false, isLoading: true },
      // Not listed this session, so nothing is known yet.
      chips: [],
    };
  };
  return [
    {
      ...rowBasics(thisDevice),
      isThisDevice: true,
      status: deviceRowStatus(thisDevice, true, undefined, null, NOW),
      appVersion: LAB_APP_VERSION,
      tunnel: "up",
      chips: chipsOf(LOCAL_DEVICE_ID),
      acceptsCommands: true,
      keepReachable: true,
    },
    {
      ...rowBasics(thinkpad),
      status: deviceStatusView({
        phase: "connected",
        remoteDeviceId: THINKPAD_ID,
        remoteAppVersion: LAB_APP_VERSION,
      }),
      appVersion: LAB_APP_VERSION,
      chips: chipsOf(THINKPAD_ID),
      // The lab's one posed forward: the Thinkpad's dev server, with
      // two connections open.
      forwards: [
        {
          forwardId: "a3f19c2e77b04d5586e1f20c9ab34d61",
          remotePort: 5173,
          localPort: 5173,
          connCount: 2,
        },
      ],
    },
    away(MINI_ID),
    away(WORKPC_ID),
  ];
}

function deviceById(id: string): DeviceInfo {
  const device = accountDevices.find((d) => d.deviceId === id);
  if (!device) throw new Error(`[scenes] no device ${id}`);
  return device;
}

function rowBasics(
  device: DeviceInfo,
): Pick<
  DevicesPageRow,
  "deviceId" | "platform" | "isThisDevice" | "name" | "icon"
> {
  return {
    deviceId: device.deviceId,
    platform: device.platform,
    isThisDevice: false,
    name: device.name,
    icon: device.icon ?? "laptop",
  };
}

// A machine's project chips, in the order its forest lists them.
function chipsOf(deviceId: string): DevicesPageRow["chips"] {
  const forest = forests[deviceId];
  if (!forest) throw new Error(`[scenes] no forest on ${deviceId}`);
  return forest.projects.map((project) => ({
    projectId: project.id,
    name: project.name,
    worktrees: forest.worktrees[project.id]?.length ?? 0,
    iconSrc: iconSrcOf(project.name),
  }));
}

// ---- the transplant dialog (TransplantScene) ----

// A device of the account, by id.
function deviceOf(deviceId: string): DeviceInfo {
  const device = accountDevices.find((d) => d.deviceId === deviceId);
  if (!device) throw new Error(`[scenes] no device ${deviceId}`);
  return device;
}

// A device's checkout of a repo, by the identity every checkout shares.
function checkoutOn(
  deviceId: string,
  identity: string | null | undefined,
): Project | undefined {
  if (identity == null) return undefined;
  return forests[deviceId]?.projects.find((p) => p.identity === identity);
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
      icon: device.icon ?? "laptop",
      project: device.online
        ? checkoutOn(device.deviceId, project.identity)
        : undefined,
      block: device.online ? undefined : ("offline" as const),
      ready: device.online,
    }));
}

// Where the copy would collide on the landing device (PullReview.tsx
// useLocalCollision), over the branches the lab says it holds: main and
// every other checked-out worktree's (lab/bridge.ts listBranches).
function landingCollisionOf(
  deviceId: string,
  landingProject: Project,
  worktree: Worktree,
  landing: Landing,
): { collision: DestinationRowCollision; refusal: string | null } {
  const forest = forests[deviceId];
  const all = forest ? Object.values(forest.worktrees).flat() : [];
  const branches = [
    "main",
    ...all.filter((w) => !w.isPrimary && !w.detached).map((w) => w.branch),
  ];
  const worktrees = forest?.worktrees[landingProject.id] ?? [];
  const landingBranch = pullLandingBranch(worktree);
  const held = branches.includes(landingBranch);
  const holder = held
    ? worktrees.find((entry) => entry.branch === landingBranch)
    : undefined;
  const name = pullWorktreeName(worktree);
  const taken =
    name !== undefined &&
    worktrees.some((entry) => entry.name.toLowerCase() === name.toLowerCase());
  const where = landing.onPeer ? landing.on : undefined;
  return {
    collision: { landingBranch, held, holderName: holder?.name },
    refusal: held
      ? pullBranchCollision(landingBranch, holder?.path, where)
      : taken
        ? pullFolderCollision(name, `${landingProject.name}/${name}`, where)
        : null,
  };
}

// Where a project's worktrees land on a device, tildified, as the
// review's folder card spells it (hooks/config/useWorktreeBaseLabel):
// the lab's config names no layout, so the managed root under the
// device's data dir (lab/bridge.ts runtime:info).
function worktreeBaseOn(deviceId: string, project: Project): string {
  const home = labDisks[deviceId]?.home ?? "/home/rin";
  return tildify(
    worktreeBaseFor(
      layoutInputsFor(labProjectConfig(), project.path, {
        dataDir: `${home}/.sm`,
        canonicalDataDirName: ".sm",
        onProjectDrive: labGlobalConfig.managedOnProjectDrive,
      }),
    ),
    home,
  );
}

// The transplant dialog's review for a local worktree sent to a peer
// (TransplantToDialog, opened from "Transplant to..."): the source
// card, the rule the dialog opens on (the project's preset, none set
// in the lab), and the picked peer's carry-over, folder, setup script
// and collision check.
export function transplantReviewOf(
  worktreeId: string,
  toDeviceId: string,
): ComponentProps<typeof TransplantDialogView> {
  const { worktree, project, deviceId } = worktreeById(worktreeId);
  const source = deviceOf(deviceId);
  const destination = deviceOf(toDeviceId);
  const landing = landsOnPeer(destination.name);
  const landingProject = checkoutOn(toDeviceId, project.identity);
  if (!landingProject) {
    throw new Error(`[scenes] ${destination.name} has no ${project.name}`);
  }
  const selection = selectionOfPreset(parseLeaveOutPreset(undefined));
  const config = labProjectConfig();
  const { collision, refusal } = landingCollisionOf(
    toDeviceId,
    landingProject,
    worktree,
    landing,
  );
  const sourceIcon = source.icon ?? "laptop";
  return {
    worktree,
    project,
    sourceDeviceLabel: source.name,
    thisDeviceLabel: destination.name,
    landing,
    source: {
      icon: sourceIcon,
      // This device's own card names no status.
      status: null,
      home: labDisks[deviceId]?.home ?? null,
      pr: pullRequestOf(project.id, worktree.branch).pr ?? null,
      prPending: false,
    },
    leaveOut: {
      selection,
      ignored: { data: undefined, isPending: false, isError: false },
      presetDiffers: false,
    },
    destination: {
      project: landingProject,
      icon: destination.icon ?? "laptop",
      collision,
      carryOver: {
        rows: (config.carryOver ?? []).map((entry) => ({
          path: entry.path,
          tag: entry.mode,
        })),
        isPending: false,
      },
      folderBase: worktreeBaseOn(toDeviceId, landingProject),
      setupCommand: config.scripts?.setup?.trim() ?? "",
    },
    sourceIcon,
    toPeer: {
      targets: peerTargetsOf(project, deviceId),
      pickedId: toDeviceId,
    },
    runSetup: setupDefaultFor(selection),
    footer: { refusal, waiting: false, blocked: null },
  };
}
