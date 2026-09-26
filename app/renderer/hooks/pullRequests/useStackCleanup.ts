// The merged layers' worktrees of a stack on every device holding the
// repo, for the closed-PR box's stack cleanup. A stack's layers can
// sit on different machines (one worktree here, the next on the
// laptop), and each machine's host removes its own through
// `sm rm --stack`, so the cleanup is one call per device. The devices
// are the repo's holders (deviceTargets), their rows the sidebar's own
// listings under the sidebar's calm refetch, so this costs no extra
// fetch; and a device is asked only while it can be commanded from
// here, which its holder entry already says.
import { useQueries } from "@tanstack/react-query";
import {
  type PullRequestStack,
  stackCleanupFor,
} from "@shared/pullRequestStack";
import type { Worktree } from "@shared/schemas";
import { isHolder, useDeviceTargets } from "@/components/shared/deviceTargets";
import { useProjects } from "@/hooks/projects/useProjects";
import { type HostApi, useHostScope } from "@/hooks/remote/useHostScope";
import { CALM_REFETCH } from "@/hooks/remote/useRemoteForests";
import { worktreesQueryOptions } from "@/hooks/worktrees/useWorktrees";

export interface StackCleanupDevice {
  deviceId: string;
  label: string;
  // The page's own device: its removal navigates the page on.
  isScoped: boolean;
  // That device's checkout of the repo, and its worktrees that go.
  projectId: string;
  worktrees: Worktree[];
  // The api to ask it through, undefined while it can't be commanded
  // (asleep, or not granting this device), with the reason.
  api: HostApi | undefined;
  block: "offline" | "no-grant" | undefined;
}

export type ReadyStackCleanupDevice = StackCleanupDevice & { api: HostApi };

export interface StackCleanup {
  ready: ReadyStackCleanupDevice[];
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
  const holders = useDeviceTargets(stack ? project : undefined).filter(
    isHolder,
  );
  const listings = useQueries({
    queries: holders.map((holder) => ({
      ...worktreesQueryOptions(holder.project.id, {
        deviceId: holder.deviceId,
        api: holder.api,
      }),
      ...CALM_REFETCH,
    })),
  });
  if (!stack) return null;
  const devices = holders.flatMap((holder, index): StackCleanupDevice[] => {
    const rows = listings[index]?.data;
    const cleanup = rows && stackCleanupFor(stack, rows);
    if (!cleanup) return [];
    const isScoped = holder.deviceId === scope.deviceId;
    return [
      {
        deviceId: holder.deviceId,
        label: holder.label,
        isScoped,
        projectId: holder.project.id,
        worktrees: cleanup.worktrees,
        api: isScoped ? scope.api : holder.api,
        block: isScoped ? undefined : holder.block,
      },
    ];
  });
  const ready = devices.filter(
    (d): d is ReadyStackCleanupDevice =>
      d.api !== undefined && d.block === undefined,
  );
  const blocked = devices.filter((d) => !ready.includes(d as never));
  return {
    ready,
    blocked,
    count: ready.reduce((sum, d) => sum + d.worktrees.length, 0),
  };
}
