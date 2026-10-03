// The lab's fixture world (../fixtures.ts) in the shapes the app's views
// take, for the scenes in this folder. Plain functions over plain data:
// a scene renders in Node (test/scenes.mts) and into the marketing site
// at build time, so nothing here may reach window, the router or a
// query.
import type { SidebarDeviceBadge } from "@/components/sidebar/DeviceBadgeView";
import type { WorktreeRowLook } from "@/components/sidebar/rowState";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { RemoteDeviceStatus } from "@/lib/remote/devices";
import { pullRequestStackPosition } from "@shared/pullRequestStack";
import type { Project, PullRequest, Worktree } from "@shared/schemas";
import { accountDevices, forests, projectIconFor } from "../fixtures";
import { labPullRequestsFor } from "../pullRequestFixtures";

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
