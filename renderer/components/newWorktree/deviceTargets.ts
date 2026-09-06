// Which machines hold THIS repo: the device tabs (shared/DeviceTabs)
// with each device's checkout of the repo laid on top, for the pages
// whose tabs are the devices holding a project and for the header's
// "Create on" pick. Identity (shared/repoIdentity.mts) is what "has
// this repo" means -- the same match the merged sidebar and the
// pull-here control use -- so a peer with a differently-named clone
// still counts and a same-named unrelated repo never does.
//
// The pages serve both trees: under /projects the project is this
// machine's, under a /devices twin it is the peer's. The scope says
// which, and the list reads the same either way -- the scoped device's
// own checkout is the project in hand, every other device's is its
// identity match.
import type { Project } from "@shared/schemas";
import { useDeviceTabs, type DeviceTab } from "@/components/shared/DeviceTabs";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useLocalProjectForIdentity } from "@/hooks/remote/useLocalProjectForIdentity";
import { useRemoteProjects } from "@/hooks/remote/useRemoteForests";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";

// Why a device can't host a create. Ordered by how the user would ask:
// a machine that isn't there can't be missing a checkout yet.
export type DeviceBlock = "offline" | "no-project" | "no-grant";

// Honest and specific, and none of them offer a fix here: reconnecting
// is the device hub's job, granting happens on the other machine's
// Devices page, and cloning a missing repo is not something this form
// does.
export const BLOCK_REASON: Record<DeviceBlock, string> = {
  offline: "Creating needs a live connection.",
  "no-project":
    "Doesn't have this repo registered. Matching by git remote found no checkout there.",
  "no-grant": peerReadOnlyNote("it"),
};

export type DeviceTarget = Omit<DeviceTab, "block"> & {
  // The identity-matched project ON THAT DEVICE -- the id every scoped
  // hook keys off once a page moves there. Undefined when the device
  // has no checkout of this repo.
  project: Project | undefined;
  // Undefined when the device can host the create.
  block: DeviceBlock | undefined;
};

// A tab with the repo's checkout on that device laid on top.
function target(
  tab: DeviceTab,
  project: Project | undefined,
  block: DeviceBlock | undefined,
): DeviceTarget {
  return { ...tab, project, block };
}

export function useDeviceTargets(project: Project | undefined): DeviceTarget[] {
  const scope = useHostScope();
  const tabs = useDeviceTabs();
  // Only an identity match per device is read out of this, and the
  // sidebar's always-mounted fan-out keeps it current, so opening a
  // page must not kick a fresh re-listing of every peer's projects.
  const { pairs } = useRemoteProjects();
  // This machine's checkout: the project in hand on a local page, its
  // identity match under a device twin.
  const localMatch = useLocalProjectForIdentity(project?.identity);

  if (project === undefined) return [];
  return tabs.map((tab): DeviceTarget => {
    if (tab.isThisDevice) {
      const held = scope.remote ? localMatch : project;
      // A checkout whose folder is gone can't take a create either.
      return target(
        tab,
        held,
        held === undefined || held.pathExists === false
          ? "no-project"
          : undefined,
      );
    }
    // A null identity (a repo with no remote, an empty checkout) can
    // never match: it means "this device couldn't tell what repo this
    // is", not "the same unknown repo". The scoped device needs no
    // match: its checkout is the project in hand.
    const held =
      tab.deviceId === scope.deviceId
        ? project
        : project.identity == null
          ? undefined
          : pairs.find(
              (pair) =>
                pair.device.deviceId === tab.deviceId &&
                pair.project.identity === project.identity,
            )?.project;
    return target(
      tab,
      held,
      tab.block === "offline"
        ? "offline"
        : held === undefined
          ? "no-project"
          : tab.block,
    );
  });
}
