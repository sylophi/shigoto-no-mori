// The lab's fixture world (../fixtures.ts) in the shapes the app's views
// take, for the scenes in this folder. Plain functions over plain data:
// a scene renders in Node (test/scenes.mts) and into the marketing site
// at build time, so nothing here may reach window, the router or a
// query.
import type { DeviceFilterChoice } from "@/components/sidebar/DeviceFilterBarView";
import {
  buildSidebarRows,
  deviceBadgeOf,
  projectGroupKey,
  projectGroupOrder,
} from "@/components/sidebar/buildSidebarRows";
import { buildInboxRows } from "@/components/sidebar/inbox/buildInboxRows";
import type { NewWorktreeTargetLook } from "@/components/sidebar/inbox/NewWorktreeButtonView";
import type { SidebarRowLookups } from "@/components/sidebar/SidebarListView";
import type { SidebarViewModel } from "@/components/sidebar/sidebarRow";
import type { ProjectShigomoriConfigQueries } from "@/hooks/config/useShigomoriConfig";
import type { ProjectPullRequestQueries } from "@/hooks/projects/useProjectPullRequests";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { ProjectWorktreeQueries } from "@/hooks/worktrees/useWorktrees";
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
import type { DevicesPageRow } from "@/components/remote/DevicesPageView";
import { deviceRowStatus } from "@/components/remote/deviceRegistryStatus";
import type { DeviceInfo } from "@shared/hub/protocol";
import type { SidebarDeviceBadge } from "@/components/sidebar/DeviceBadgeView";
import type { WorktreeRowLook } from "@/components/sidebar/rowState";
import type { FooterLeadingVerb } from "@/components/worktreeDetail/FooterLeadingVerbView";
import {
  type LifecycleRow,
  lifecycleRowsOf,
} from "@/components/worktreeDetail/scripts/lifecycleRows";
import {
  type SortableEntry,
  sortEntries,
} from "@/components/worktreeDetail/scripts/sortPackageScripts";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { RemoteDeviceStatus } from "@/lib/remote/devices";
import { mirrorEngineBlocker } from "@shared/ipc/modules/mirror";
import {
  type PullRequestStack,
  pullRequestStackFor,
  pullRequestStackPosition,
  stackCleanupFor,
  trunkOf,
} from "@shared/pullRequestStack";
import {
  isRealBranch,
  type Project,
  type PullRequest,
  type PullRequestDetail,
  type Worktree,
} from "@shared/schemas";
import {
  LAB_APP_VERSION,
  LOCAL_DEVICE_ID,
  MINI_ID,
  THINKPAD_ID,
  WORKPC_ID,
  accountDevices,
  forests,
  labDisks,
  labGlobalConfig,
  labPackageScriptSort,
  labPackageScripts,
  labPortPoolActive,
  labShigomoriConfig,
  projectIconFor,
} from "../fixtures";
import {
  labPullRequestDetailFor,
  labPullRequestsFor,
} from "../pullRequestFixtures";

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

// ---- the worktree page (DetailScene.tsx) ----

// The folder a device's paths shorten against (~/...).
export function homeOf(deviceId: string): string {
  const disk = labDisks[deviceId];
  if (!disk) throw new Error(`[scenes] no disk for ${deviceId}`);
  return disk.home;
}

// Every checkout of a project's repo across the account's devices, with
// whether that device takes commands from this one.
function checkoutsOf(project: Project): {
  worktrees: Worktree[];
  grantsCaller: boolean;
}[] {
  return Object.values(forests).flatMap((forest) =>
    forest.projects
      .filter(
        (candidate) =>
          candidate.id === project.id ||
          (project.identity != null && candidate.identity === project.identity),
      )
      .map((candidate) => ({
        worktrees: forest.worktrees[candidate.id] ?? [],
        grantsCaller: forest.grantsCaller,
      })),
  );
}

// A branch's PR as the worktree page reads it, with the stack it sits
// in (the whole chain, as the stack list draws it).
export function pullRequestDetailOf(
  project: Project,
  branch: string,
  merged = false,
): { pr: PullRequestDetail | null; stack: PullRequestStack | null } {
  const prs = labPullRequestsFor(project.id, merged) as Record<
    string,
    PullRequest
  >;
  const own = Object.values(forests).find((forest) =>
    forest.projects.some((candidate) => candidate.id === project.id),
  );
  return {
    pr: labPullRequestDetailFor(
      project.id,
      branch,
      merged,
    ) as PullRequestDetail | null,
    stack: pullRequestStackFor(
      prs,
      branch,
      trunkOf(own?.worktrees[project.id]),
    ),
  };
}

// How many worktrees the closed PR box's stack cleanup takes: the
// merged layers' worktrees on every device that takes commands.
export function stackCleanupCountOf(
  project: Project,
  stack: PullRequestStack | null,
): number {
  if (!stack) return 0;
  return checkoutsOf(project)
    .filter(({ grantsCaller }) => grantsCaller)
    .reduce(
      (count, { worktrees }) =>
        count + (stackCleanupFor(stack, worktrees)?.worktrees.length ?? 0),
      0,
    );
}

// The package.json scripts in the order the project sorts them, which
// the Launch row and the Scripts section share.
export function packageScriptsOf(): SortableEntry[] {
  return sortEntries(
    Object.entries(labPackageScripts.scripts),
    labPackageScriptSort,
    labPackageScripts.usage,
    [],
  );
}

// The Scripts section's lifecycle rows for a worktree.
export function lifecycleOf(worktree: Worktree): LifecycleRow[] {
  return lifecycleRowsOf({
    setupCommand: labShigomoriConfig.scripts?.setup?.trim() ?? "",
    teardownCommand: labShigomoriConfig.scripts?.teardown?.trim() ?? "",
    portPoolActive: labPortPoolActive,
    path: worktree.path,
  });
}

// The footer's leading verbs on this machine's own worktree page:
// Files and Ports, then the ways to another device. The lab's mirror
// engine is stopped until a mirror starts, so Mirror to… is off.
export function footerVerbsOf(
  worktree: Worktree,
  project: Project,
): FooterLeadingVerb[] {
  const verbs: FooterLeadingVerb[] = [{ kind: "files" }, { kind: "ports" }];
  const transferable =
    !worktree.detached &&
    isRealBranch(worktree.branch) &&
    project.identity != null;
  if (!transferable) return verbs;
  verbs.push({
    kind: "mirrorTo",
    disabledReason: mirrorEngineBlocker("stopped"),
  });
  if (!worktree.isPrimary) verbs.push({ kind: "transplantTo" });
  return verbs;
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
      layoutInputsFor(labShigomoriConfig, project.path, {
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
  const config = labShigomoriConfig;
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

// ---- the sidebar ----

// Which app draws the forest: the desktop window on Studio Mac, whose
// own projects are local there, or the web shell, a browser on the
// account to which every machine is a peer (lab/README.md).
export type LabShell = "desktop" | "web";

// This machine's name, the desktop lab's local device.
export const LOCAL_DEVICE_NAME =
  accountDevices.find((d) => d.deviceId === LOCAL_DEVICE_ID)?.name ?? "";

// The lab's default presence: the Thinkpad connected and the rest off,
// and on the web Studio Mac connected too.
function peerStatus(shell: LabShell, deviceId: string): RemoteDeviceStatus {
  const connected =
    deviceId === THINKPAD_ID ||
    (shell === "web" && deviceId === LOCAL_DEVICE_ID);
  return connected
    ? {
        phase: "connected",
        remoteDeviceId: deviceId,
        remoteAppVersion: "2.0.3",
      }
    : { phase: "stopped" };
}

// The shell's peers, in the account's order.
function peersOf(shell: LabShell) {
  return accountDevices.filter(
    (device) => shell === "web" || device.deviceId !== LOCAL_DEVICE_ID,
  );
}

// Every peer's badge by device id (useDeviceBadges).
function deviceBadges(shell: LabShell): Map<string, SidebarDeviceBadge> {
  return new Map(
    peersOf(shell).map((device) => [
      device.deviceId,
      badgeOf(device.deviceId, peerStatus(shell, device.deviceId)),
    ]),
  );
}

// The device filter's machines (useDeviceRoster): this one first, then
// the reachable peers, then the rest.
export function deviceFilterChoices(shell: LabShell): DeviceFilterChoice[] {
  const here: DeviceFilterChoice[] =
    shell === "desktop"
      ? [
          {
            deviceId: LOCAL_DEVICE_ID,
            label: LOCAL_DEVICE_NAME,
            icon: "mini",
            status: null,
          },
        ]
      : [];
  const peers = peersOf(shell).map((device) => ({
    deviceId: device.deviceId,
    label: device.name,
    icon: device.icon ?? "laptop",
    status: deviceStatusView(peerStatus(shell, device.deviceId)),
  }));
  return [
    ...here,
    ...peers.filter((peer) => peer.status.reachable),
    ...peers.filter((peer) => !peer.status.reachable),
  ];
}

// The peers' forests the sidebar merges in (useRemoteForests): one item
// per project on every connected peer. The ones that are off have
// never been listed in the lab, so they have nothing cached to show.
export function remoteForests(shell: LabShell): RemoteForestItem[] {
  return peersOf(shell).flatMap((device) => {
    const status = peerStatus(shell, device.deviceId);
    const forest = forests[device.deviceId];
    if (status.phase !== "connected" || !forest) return [];
    const { tone, reachable } = deviceStatusView(status);
    return forest.projects.map((project) => ({
      deviceId: device.deviceId,
      deviceLabel: device.name,
      deviceIcon: device.icon ?? "laptop",
      reachable,
      tone,
      project,
      worktrees: forest.worktrees[project.id] ?? [],
      pullRequests: labPullRequestsFor(project.id) as Record<
        string,
        PullRequest
      >,
      showPrimaryInInbox: false,
      worktreesError: false,
    }));
  });
}

// A settled query's result as the fan-outs hand it to the builders
// (combineFanOut), standing in for the live one.
const settled = <T>(data: T) => ({
  data,
  error: null,
  isLoading: false,
  isPending: false,
});

// This machine's projects and their listings, in the stored (manual)
// order the lab sorts by. The web shell has none.
function localInputs(shell: LabShell) {
  const forest = forests[LOCAL_DEVICE_ID];
  const projects = shell === "desktop" && forest ? forest.projects : [];
  const worktreeQueries: ProjectWorktreeQueries = projects.map((project) =>
    settled(forest?.worktrees[project.id] ?? []),
  );
  const pullRequestQueries: ProjectPullRequestQueries = projects.map(
    (project) => settled(labPullRequestsFor(project.id)),
  );
  // No project keeps a config of its own, so none shows its primary in
  // the inbox.
  const configQueries: ProjectShigomoriConfigQueries = projects.map(() =>
    settled(null),
  );
  return { projects, worktreeQueries, pullRequestQueries, configQueries };
}

// The inbox's rows, its shelves shut.
export function labInboxRows(shell: LabShell): SidebarViewModel {
  return buildInboxRows({
    ...localInputs(shell),
    remote: remoteForests(shell),
    mirrors: [],
    deviceBadges: deviceBadges(shell),
    openShelves: new Set(),
    hiddenPrefixes: [],
  });
}

// The device a worktree is named under in a shell's rows: undefined for
// the desktop's own.
function rowDeviceOf(shell: LabShell, deviceId: string): string | undefined {
  return shell === "desktop" && deviceId === LOCAL_DEVICE_ID
    ? undefined
    : deviceId;
}

// The group key (projectGroupKey) of the project a worktree belongs to.
export function groupKeyOfWorktree(shell: LabShell, worktreeId: string) {
  const { project, deviceId } = worktreeById(worktreeId);
  return projectGroupKey(project, rowDeviceOf(shell, deviceId));
}

// The tree's rows, inside the project `openKey` names or on the list
// of projects (null), its worktrees by name and its shelves shut.
export function labTreeRows(
  shell: LabShell,
  openKey: string | null,
): SidebarViewModel {
  const local = localInputs(shell);
  const remote = remoteForests(shell);
  return buildSidebarRows({
    ...local,
    openKey,
    worktreeSort: "name",
    order: projectGroupOrder({
      projects: local.projects,
      remote,
      sortMode: "manual",
    }),
    openShelves: { shelved: new Set(), hidden: new Set() },
    hiddenPrefixes: [],
    arrangeMode: false,
    remote,
    mirrors: [],
    deviceBadges: deviceBadges(shell),
  });
}

// The ports the desktop forwards from a peer's worktree, as the lab
// poses them (the bridge's one pre-posed forward).
const LAB_FORWARDS = [
  {
    deviceId: THINKPAD_ID,
    worktreeId: "a1b2c3d4e5f6",
    remotePort: 5173,
    localPort: 5173,
  },
];

function forwardTipOf(deviceId: string, worktree: Worktree) {
  const pairs = LAB_FORWARDS.filter(
    (f) => f.deviceId === deviceId && f.worktreeId === worktree.id,
  ).map((f) => `${f.remotePort} to localhost:${f.localPort}`);
  return pairs.length > 0 ? `Forwarding ${pairs.join(", ")}` : undefined;
}

// What the rows look up, with `selected` (a worktree id) the one whose
// page is open, or null for none.
export function labRowLookups(
  shell: LabShell,
  selected: string | null,
): SidebarRowLookups {
  const open = selected === null ? null : worktreeById(selected);
  const openDevice = open && rowDeviceOf(shell, open.deviceId);
  return {
    now: NOW,
    showDeviceBadges: true,
    markTerrierProjects: false,
    lookOf: (worktree, deviceId) => ({
      ...QUIET_LOOK,
      isSelected:
        open !== null && worktree.id === selected && deviceId === openDevice,
      title: worktree.shelved ? "Shelved" : undefined,
    }),
    iconSrcOf: (project) => iconSrcOf(project.name),
    // Only the desktop forwards: the browser has no ports of its own.
    forwardTipOf: (worktree, deviceId) =>
      shell === "desktop" ? forwardTipOf(deviceId, worktree) : undefined,
    currentGroupKey:
      selected === null ? undefined : groupKeyOfWorktree(shell, selected),
    localDeviceLabel: shell === "desktop" ? LOCAL_DEVICE_NAME : undefined,
  };
}

// Where the inbox's New worktree can create: this machine's projects,
// then those of every connected peer that takes this device's commands.
export function labNewWorktreeTargets(
  shell: LabShell,
): NewWorktreeTargetLook[] {
  const local = localInputs(shell)
    .projects.filter((project) => project.pathExists !== false)
    .map((project) => ({
      key: project.id,
      name: project.name,
      iconSrc: iconSrcOf(project.name),
      device: undefined,
    }));
  const remote = remoteForests(shell)
    .filter((item) => forests[item.deviceId]?.grantsCaller === true)
    .map((item) => ({
      key: `${item.deviceId}/${item.project.id}`,
      name: item.project.name,
      iconSrc: iconSrcOf(item.project.name),
      device: deviceBadgeOf(item),
    }));
  return [...local, ...remote];
}
