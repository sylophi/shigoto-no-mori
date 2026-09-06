// The frame every project page shares (new worktree, configure, manage
// branches, worktree location, convert external): the project the
// route names, a header led by the device tab bar (DeviceTabs) with
// one tab per device that holds the repo, and the body under the
// picked device's scope. Each device keeps its own project file,
// branches and worktrees, so the body is the picked device's copy, and
// picking another tab swaps whose copy the page shows. The tabs are
// the same identity match the header's "Create on" pick draws
// (useDeviceTargets), less the devices with no checkout of this repo.
// A project held on one device alone gets no tab bar, only the plain
// chip the worktree page wears when it is a peer's (nothing at all
// locally): there is no pick to make.
import type { ReactNode } from "react";
import { PawPrint } from "lucide-react";
import { DeviceChip } from "@/components/remote/DeviceChip";
import { CenteredMessage } from "@/components/ui/centered-message";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  useDeviceTargets,
  type DeviceTarget,
} from "@/components/newWorktree/deviceTargets";
import { useScopedProjectParams } from "@/hooks/projects/useProjectNav";
import { useProjects } from "@/hooks/projects/useProjects";
import { useHostScope } from "@/hooks/remote/useHostScope";
import type { Project } from "@shared/schemas";
import {
  DeviceTabBar,
  DeviceTabPanel,
  usePickedDevice,
  type DeviceTab,
} from "./DeviceTabs";
import { PageHeader } from "./PageHeader";

type Holder = DeviceTab & { project: Project };

// A device with a checkout of the repo whose folder is still there.
function isHolder(target: DeviceTarget): target is DeviceTarget & Holder {
  return target.project !== undefined && target.block !== "no-project";
}

export function ProjectDevicePage({
  title,
  children,
}: {
  title: string;
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

  if (!project) {
    return <CenteredMessage>Project not found.</CenteredMessage>;
  }

  const tabbed = holders.length > 1 && picked !== undefined;
  // The body's device while the peers' answers are still landing (or
  // there is only this one): the scoped device itself, which is what
  // the first holder resolves to, so the panel keeps its key.
  const shown: DeviceTab = picked ?? {
    deviceId: scope.deviceId,
    label: "",
    isThisDevice: !scope.remote,
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
              selectedId={picked.deviceId}
              onSelect={pick}
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
            {/* With tabs they name the device; without them the chip
                does, for a peer's project (nothing locally). */}
            {!tabbed && <DeviceChip />}
          </>
        }
      />
      <DeviceTabPanel tab={shown} subject="its copy of this project">
        {children(picked?.project ?? project, tabbed ? picked : undefined)}
      </DeviceTabPanel>
    </div>
  );
}
