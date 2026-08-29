// Which machines can host a new worktree for THIS repo, as one list the
// picker renders straight through: this device first, then every
// enrolled peer, each carrying the single fact that decides whether it
// can be picked at all.
//
// A peer qualifies on three counts, checked in the order the user would
// ask them: is it reachable, does it have this repo, and will it let us
// run commands. Identity (shared/repoIdentity.mts) is what "has this
// repo" means -- the same match the merged sidebar and the pull-here
// control use -- so a peer with a differently-named clone still counts
// and a same-named unrelated repo never does.
import type { Project } from "@shared/schemas";
import { useAccountStatus } from "@/hooks/account/useAccount";
import { usePeerCommandAccess } from "@/hooks/remote/useCommandAccess";
import type { HostApi } from "@/hooks/remote/useHostScope";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { useRemoteForests } from "@/hooks/remote/useRemoteForests";
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
  // The api the form would be scoped to. Present only while the peer has
  // a session.
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
export function useDeviceTargets(
  project: Project | undefined,
  worktreeCount: number,
): DeviceTarget[] {
  const devices = useRemoteDevices();
  const forests = useRemoteForests();
  const access = usePeerCommandAccess(devices);
  const { data: account } = useAccountStatus();

  if (devices.length === 0 || project === undefined) return [];

  const here: DeviceTarget = {
    deviceId: localDeviceId,
    label: account?.deviceName ?? "This device",
    isThisDevice: true,
    status: null,
    api: undefined,
    project,
    worktreeCount,
    block: undefined,
  };

  return [
    here,
    ...devices.map((device): DeviceTarget => {
      const status = deviceStatusView(device.status);
      // A null identity (a repo with no remote, an empty checkout) can
      // never match: it means "this device couldn't tell what repo this
      // is", not "the same unknown repo".
      const match =
        project.identity == null
          ? undefined
          : forests.items.find(
              (item) =>
                item.deviceId === device.deviceId &&
                item.project.identity === project.identity,
            );
      return {
        deviceId: device.deviceId,
        label: device.label,
        isThisDevice: false,
        status,
        api: device.api,
        project: match?.project,
        worktreeCount: match?.worktrees.length,
        block:
          !status.reachable || device.api === undefined
            ? "offline"
            : match === undefined
              ? "no-project"
              : access.get(device.deviceId)?.granted === true
                ? undefined
                : "no-grant",
      };
    }),
  ];
}
