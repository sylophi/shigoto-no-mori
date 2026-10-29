// The frame every project page shares (new worktree, configure, manage
// branches, worktree location, convert external): the project the
// route names, a header led by the device tab bar (DeviceTabs) with
// one tab per device that holds the repo, and the body under the
// picked device's scope. Each device keeps its own project file,
// branches and worktrees, so the body is the picked device's copy, and
// picking another tab swaps whose copy the page shows. The tabs are
// the same identity match the Configure page's "Create on" pick draws
// (useDeviceTargets), less the devices with no checkout of this repo.
// A project held on one device alone gets no tab bar, only the plain
// chip the worktree page wears when it is a peer's (nothing at all
// locally): there is no pick to make. A page may add one more tab ahead
// of the devices, for what belongs to all of them at once (`renderAllDevices`).
import { useState, type ReactNode } from "react";
import { DeviceChip } from "@/components/shared/DeviceChip";
import { CenteredMessage } from "@shigomori/ui/primitives/centered-message.tsx";
import { isHolder, useDeviceTargets } from "@/components/shared/deviceTargets";
import {
  useProjectNav,
  useRoutedProject,
  type ProjectPage,
} from "@/hooks/projects/useProjectNav";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import type { Project } from "@shigomori/contracts/schemas";
import {
  DeviceTabPanel,
  usePickedDevice,
  type DeviceTab,
} from "@/components/shared/DeviceTabs";
import {
  ALL_DEVICES_TAB_ID,
  DeviceTabBarView,
} from "@shigomori/ui/views/shared/DeviceTabBarView.tsx";
import { ProjectDevicePageView } from "@shigomori/ui/views/shared/ProjectDevicePageView.tsx";

export function ProjectDevicePage({
  title,
  parent,
  renderAllDevices,
  devicesLocked = false,
  children,
}: {
  title: string;
  // The page this one is a subpage of, linked from the eyebrow after
  // the project's name. The link keeps the picked device.
  parent?: { label: string; page: ProjectPage };
  // The body of the "All devices" tab: what the page holds that is no
  // one device's copy (the project's shared settings). Given the routed
  // project, since it is about the repo and not a checkout. The tab
  // joins the bar only when there is one, so a project on a single
  // device, with nothing to share, never shows it.
  renderAllDevices?: (project: Project) => ReactNode;
  // Every device's copy is kept the same (Configure while the settings
  // sync): the device tabs are disabled, and the all-devices tab shows
  // the routed device's body.
  devicesLocked?: boolean;
  // The body, given the picked device's copy of the project, when
  // there is a choice the tab it came from, and whether it shows under
  // the locked all-devices tab. It reads everything else through the
  // host-scoped hooks, so it needs no remote-awareness of its own.
  children: (
    project: Project,
    tab: DeviceTab | undefined,
    locked: boolean,
  ) => ReactNode;
}) {
  const scope = useHostScope();
  const { toProjectPage } = useProjectNav();
  const project = useRoutedProject();
  const holders = useDeviceTargets(project).filter(isHolder);
  // The tab the page opens on is the device the route named. A route
  // change remounts the page (remountDeps), so this never goes stale.
  const [picked, pick] = usePickedDevice(holders, scope.deviceId);
  const [allDevicesPicked, setAllDevicesPicked] = useState(false);
  const { canCommand } = useCommandAccess();
  const scopedLabel = useRemoteDeviceLabel(scope.deviceId);

  const tabbed = holders.length > 1 && picked !== undefined;
  const locked = tabbed && devicesLocked;
  // Turning the lock off stays on the tab it was turned off from.
  if (locked && !allDevicesPicked) setAllDevicesPicked(true);

  if (!project) {
    return <CenteredMessage>Project not found.</CenteredMessage>;
  }

  // A pick only means something with a bar to make it on. Without one
  // (the peers' answers still landing, or nothing to choose between)
  // the body is the routed project under the routed device, so a
  // missing local checkout can never swap the page to a peer's copy
  // unannounced. The scoped device is what the first holder resolves
  // to anyway, so the panel keeps its key when the bar appears, and it
  // is blocked the way its tab would be.
  const devicePicked = tabbed && !locked;
  const showAllDevices =
    devicePicked && renderAllDevices !== undefined && allDevicesPicked;
  const shown: DeviceTab = devicePicked
    ? picked
    : {
        deviceId: scope.deviceId,
        label: scopedLabel,
        icon: "desktop",
        isThisDevice: !scope.remote,
        status: null,
        api: scope.api,
        block: canCommand ? undefined : "no-grant",
      };

  return (
    <ProjectDevicePageView
      projectName={project.name}
      title={title}
      parent={
        parent && {
          label: parent.label,
          // Each device's copy of the project has an id of its own, so
          // the link takes the picked copy's with its device.
          onOpen: () =>
            toProjectPage(
              parent.page,
              devicePicked ? picked.project.id : project.id,
              shown.deviceId,
            ),
        }
      }
      tabs={
        tabbed ? (
          <DeviceTabBarView
            tabs={holders}
            selectedId={allDevicesPicked ? ALL_DEVICES_TAB_ID : picked.deviceId}
            onSelect={(id) => {
              setAllDevicesPicked(id === ALL_DEVICES_TAB_ID);
              if (id !== ALL_DEVICES_TAB_ID) pick(id);
            }}
            allDevicesTab={renderAllDevices !== undefined}
            devicesDisabled={locked}
          />
        ) : undefined
      }
      terrier={project.source === "terrier"}
      // With tabs they name the device.
      chip={tabbed ? undefined : <DeviceChip />}
      showAllDevices={showAllDevices}
      body={
        <DeviceTabPanel tab={shown} subject="its copy of this project">
          {children(
            devicePicked ? picked.project : project,
            devicePicked ? picked : undefined,
            locked,
          )}
        </DeviceTabPanel>
      }
      allDevices={showAllDevices ? renderAllDevices(project) : undefined}
    />
  );
}
