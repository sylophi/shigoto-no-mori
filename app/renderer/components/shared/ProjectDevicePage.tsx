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
import { PawPrint } from "lucide-react";
import { DeviceChip } from "@/components/shared/DeviceChip";
import { CenteredMessage } from "@/components/ui/centered-message";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { isHolder, useDeviceTargets } from "@/components/shared/deviceTargets";
import { useScopedProjectParams } from "@/hooks/projects/useProjectNav";
import { useProjects } from "@/hooks/projects/useProjects";
import { useHostScope } from "@/hooks/remote/useHostScope";
import type { Project } from "@shared/schemas";
import {
  ALL_DEVICES_TAB_ID,
  DeviceTabBar,
  DeviceTabPanel,
  usePickedDevice,
  type DeviceTab,
} from "./DeviceTabs";
import { PageHeader } from "./PageHeader";

export function ProjectDevicePage({
  title,
  renderAllDevices,
  children,
}: {
  title: string;
  // The body of the "All devices" tab: what the page holds that is no
  // one device's copy (the project's shared settings). Given the routed
  // project, since it is about the repo and not a checkout. The tab
  // joins the bar only when there is one, so a project on a single
  // device, with nothing to share, never shows it.
  renderAllDevices?: (project: Project) => ReactNode;
  // The body, given the picked device's copy of the project and, when
  // there is a choice, the tab it came from. It reads everything else
  // through the host-scoped hooks, so it needs no remote-awareness of
  // its own.
  children: (project: Project, tab: DeviceTab | undefined) => ReactNode;
}) {
  const { projectId } = useScopedProjectParams();
  const scope = useHostScope();
  const { data: projects = [] } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const holders = useDeviceTargets(project).filter(isHolder);
  // The tab the page opens on is the device the route named. A route
  // change remounts the page (remountDeps), so this never goes stale.
  const [picked, pick] = usePickedDevice(holders, scope.deviceId);
  const [allDevicesPicked, setAllDevicesPicked] = useState(false);

  if (!project) {
    return <CenteredMessage>Project not found.</CenteredMessage>;
  }

  // A pick only means something with a bar to make it on. Without one
  // (the peers' answers still landing, or nothing to choose between)
  // the body is the routed project under the routed device, so a
  // missing local checkout can never swap the page to a peer's copy
  // unannounced. The scoped device is what the first holder resolves
  // to anyway, so the panel keeps its key when the bar appears.
  const tabbed = holders.length > 1 && picked !== undefined;
  const showAllDevices =
    tabbed && renderAllDevices !== undefined && allDevicesPicked;
  const shown: DeviceTab = tabbed
    ? picked
    : {
        deviceId: scope.deviceId,
        label: "",
        icon: "desktop",
        isThisDevice: !scope.remote,
        hostsProjects: true,
        status: null,
        api: scope.api,
        block: undefined,
      };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow={project.name}
        title={title}
        tabs={
          tabbed ? (
            <DeviceTabBar
              tabs={holders}
              selectedId={showAllDevices ? ALL_DEVICES_TAB_ID : picked.deviceId}
              onSelect={(id) => {
                setAllDevicesPicked(id === ALL_DEVICES_TAB_ID);
                if (id !== ALL_DEVICES_TAB_ID) pick(id);
              }}
              allDevicesTab={renderAllDevices !== undefined}
            />
          ) : undefined
        }
        trailing={
          <>
            {/* A terrier-sourced project is otherwise indistinguishable
                from a registered one, and the difference shows up in
                what you can do to it (no remove, no reordering). */}
            {project.source === "terrier" && (
              <SimpleTooltip tip="Registered via terrier">
                <span className="inline-flex shrink-0">
                  <PawPrint
                    aria-label="Registered via terrier"
                    className="size-4 text-muted-foreground/70"
                  />
                </span>
              </SimpleTooltip>
            )}
            {/* With tabs they name the device. Without them the chip
                does, for a peer's project (nothing locally). */}
            {!tabbed && <DeviceChip />}
          </>
        }
      />
      {/* The device body stays mounted under the all-devices tab, so a
          form's unsaved edits survive the visit. */}
      <div className={showAllDevices ? "hidden" : "contents"}>
        <DeviceTabPanel tab={shown} subject="its copy of this project">
          {children(
            tabbed ? picked.project : project,
            tabbed ? picked : undefined,
          )}
        </DeviceTabPanel>
      </div>
      {showAllDevices && renderAllDevices(project)}
    </div>
  );
}
