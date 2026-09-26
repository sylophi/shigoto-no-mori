// The merged layers' worktrees of a stack on every device holding the
// repo, for the closed-PR box's stack cleanup. A stack's layers can
// sit on different machines (one worktree here, the next on the
// laptop), and each machine's host removes its own through
// `sm land --stack`, so the cleanup is one call per device. The
// devices are the repo's holders (deviceTargets), their rows the
// sidebar's own listings, so this costs no extra fetch; and a device
// is asked only while it can be commanded from here.
import { useQueries } from "@tanstack/react-query";
import {
  type PullRequestStack,
  stackCleanupFor,
} from "@shared/pullRequestStack";
import type { Worktree } from "@shared/schemas";
import { isHolder, useDeviceTargets } from "@/components/shared/deviceTargets";
import { useProjects } from "@/hooks/projects/useProjects";
import { useCommandableApi } from "@/hooks/remote/useCommandAccess";
import { type HostApi, useHostScope } from "@/hooks/remote/useHostScope";
import { worktreesQueryOptions } from "@/hooks/worktrees/useWorktrees";

export interface StackCleanupDevice {
  deviceId: string;
  label: string;
  // The page's own device: its removal navigates the page on.
  isScoped: boolean;
  // That device's checkout of the repo, and the worktree its land runs in.
  projectId: string;
  targetId: string;
  worktrees: Worktree[];
  // The api to ask it through, undefined while it can't be commanded
  // (asleep, or not granting this device), with the reason.
  api: HostApi | undefined;
  block: "offline" | "no-grant" | undefined;
}

export interface StackCleanup {
  // Every device with a landed layer's worktree, the page's own first.
  devices: StackCleanupDevice[];
  ready: StackCleanupDevice[];
  blocked: StackCleanupDevice[];
  // The worktrees the ready devices remove between them.
  count: number;
}

export function useStackCleanup(
  worktree: Worktree,
  stack: PullRequestStack | null,
): StackCleanup | null {
  const scope = useHostScope();
  const { data: projects = [] } = useProjects();
  const project = projects.find((p) => p.id === worktree.projectId);
  const holders = useDeviceTargets(project).filter(isHolder);
  const commandableApi = useCommandableApi();
  const listings = useQueries({
    queries: holders.map((holder) =>
      worktreesQueryOptions(holder.project.id, {
        deviceId: holder.deviceId,
        api: holder.api,
      }),
    ),
  });
  if (!stack) return null;
  const devices = holders.flatMap((holder, index) => {
    const rows = listings[index]?.data;
    const cleanup = rows && stackCleanupFor(stack, rows);
    if (!cleanup) return [];
    const isScoped = holder.deviceId === scope.deviceId;
    const api = isScoped
      ? scope.api
      : holder.isThisDevice
        ? window.api
        : commandableApi(holder.deviceId);
    return [
      {
        deviceId: holder.deviceId,
        label: holder.label,
        isScoped,
        projectId: holder.project.id,
        targetId: cleanup.target.id,
        worktrees: cleanup.worktrees,
        api,
        block: isScoped ? undefined : holder.block,
      },
    ];
  });
  devices.sort((a, b) => Number(b.isScoped) - Number(a.isScoped));
  const ready = devices.filter(
    (d) => d.api !== undefined && d.block === undefined,
  );
  const blocked = devices.filter((d) => !ready.includes(d));
  return {
    devices,
    ready,
    blocked,
    count: ready.reduce((sum, d) => sum + d.worktrees.length, 0),
  };
}
