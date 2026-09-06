// Which machines can host a new worktree for THIS repo, as one list the
// picker renders straight through: this device first (when the client
// has one), then every enrolled peer, each carrying the single fact
// that decides whether it can be picked at all.
//
// A peer qualifies on three counts, checked in the order the user would
// ask them: is it reachable, does it have this repo, and will it let us
// run commands. Identity (shared/repoIdentity.mts) is what "has this
// repo" means -- the same match the merged sidebar and the pull-here
// control use -- so a peer with a differently-named clone still counts
// and a same-named unrelated repo never does.
//
// The page serves both trees: under /projects the project is this
// machine's, under a /devices twin it is the peer's. The scope says
// which, and the list reads the same either way -- the scoped device's
// own checkout is the project in hand, every other device's is its
// identity match.
import { useQuery } from "@tanstack/react-query";
import type { Project } from "@shared/schemas";
import { useLocalDeviceName } from "@/hooks/account/useAccount";
import {
  commandAccessOf,
  usePeerCommandAccess,
} from "@/hooks/remote/useCommandAccess";
import { useHostScope, type HostApi } from "@/hooks/remote/useHostScope";
import { useLocalProjectForIdentity } from "@/hooks/remote/useLocalProjectForIdentity";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { useRemoteForests } from "@/hooks/remote/useRemoteForests";
import { worktreesQueryOptions } from "@/hooks/worktrees/useWorktrees";
import { hasLocalHost } from "@/lib/localHost";
import { localDeviceId } from "@/lib/queryKeys";
import {
  deviceStatusView,
  type DeviceStatusView,
} from "@/lib/remote/deviceStatus";

// Why a device can't host the create. Ordered by how the user would
// ask: a machine that isn't there can't be missing a checkout yet.
export type DeviceBlock = "offline" | "no-project" | "no-grant";

export interface DeviceTarget {
  deviceId: string;
  label: string;
  isThisDevice: boolean;
  // Null for this device, which has no connection to describe.
  status: DeviceStatusView | null;
  // The api the form would be scoped to: window.api for this device, a
  // peer's only while it has a session.
  api: HostApi | undefined;
  // The identity-matched project ON THAT DEVICE -- the id every scoped
  // hook keys off once the form moves there, and the path the card
  // shows. Undefined when the device has no checkout of this repo.
  project: Project | undefined;
  worktreeCount: number | undefined;
  // Undefined when the device can host the create.
  block: DeviceBlock | undefined;
}

// Empty when there is nothing to choose between: no account, no peers,
// or no project to match on. The picker renders nothing at all then, so
// a single-device install sees exactly the form it always had.
// `worktreeCount` is the scoped device's own count for this project,
// where the caller already reads it. A caller that only wants the
// devices leaves it out.
export function useDeviceTargets(
  project: Project | undefined,
  worktreeCount?: number,
): DeviceTarget[] {
  const scope = useHostScope();
  const devices = useRemoteDevices();
  // Only an identity match per device is read out of this, and the
  // sidebar's always-mounted fan-out keeps it current, so opening the
  // page must not kick a fresh re-listing of every peer's forest.
  const forests = useRemoteForests();
  const access = usePeerCommandAccess(devices);
  const localName = useLocalDeviceName();
  // This machine's checkout: the project in hand on a local page, its
  // identity match under a device twin. A hostless client has none.
  const localMatch = useLocalProjectForIdentity(project?.identity);
  const localProject = !hasLocalHost
    ? undefined
    : scope.remote
      ? localMatch
      : project;
  // Explicitly scope-less: the count for this machine's card under a
  // device twin. On a local page the caller's own count is this one,
  // so the query stays off rather than observe it twice.
  const { data: localWorktrees } = useQuery(
    worktreesQueryOptions(scope.remote ? (localProject?.id ?? null) : null, {}),
  );

  if (devices.length === 0 || project === undefined) return [];

  const here: DeviceTarget[] = hasLocalHost
    ? [
        {
          deviceId: localDeviceId,
          label: localName,
          isThisDevice: true,
          status: null,
          api: window.api,
          project: localProject,
          worktreeCount: scope.remote ? localWorktrees?.length : worktreeCount,
          // A checkout whose folder is gone can't take a create either.
          block:
            localProject === undefined || localProject.pathExists === false
              ? "no-project"
              : undefined,
        },
      ]
    : [];

  return [
    ...here,
    ...devices.map((device): DeviceTarget => {
      const status = deviceStatusView(device.status);
      const scoped = device.deviceId === scope.deviceId;
      // A null identity (a repo with no remote, an empty checkout) can
      // never match: it means "this device couldn't tell what repo this
      // is", not "the same unknown repo". The scoped device needs no
      // match: its checkout is the project in hand.
      const held =
        project.identity == null
          ? undefined
          : forests.items.find(
              (item) =>
                item.deviceId === device.deviceId &&
                item.project.identity === project.identity,
            );
      const match = scoped
        ? { project, worktreeCount }
        : held && {
            project: held.project,
            worktreeCount: held.worktrees.length,
          };
      return {
        deviceId: device.deviceId,
        label: device.label,
        isThisDevice: false,
        status,
        api: device.api,
        project: match?.project,
        worktreeCount: match?.worktreeCount,
        block:
          !status.reachable || device.api === undefined
            ? "offline"
            : match === undefined
              ? "no-project"
              : commandAccessOf(access, device.deviceId).granted
                ? undefined
                : "no-grant",
      };
    }),
  ];
}
