// The frame every project page shares (new worktree, configure, manage
// branches, worktree location, convert external): a header led by the
// device tab bar (DeviceTabs), one tab per device that holds the repo.
// Each device keeps its own project file, branches and worktrees, so
// the body is the picked device's copy, mounted under its HostScope,
// and picking another tab swaps whose copy the page shows. The tabs
// are the same identity match the header's "Create on" pick draws
// (useDeviceTargets), less the devices with no checkout of this repo.
// A project held on one device alone gets no tab bar, only the plain
// chip the worktree page wears when it is a peer's (nothing at all
// locally): there is no pick to make.
import type { ReactNode } from "react";
import { DeviceChip } from "@/components/remote/DeviceChip";
import {
  useDeviceTargets,
  type DeviceTarget,
} from "@/components/newWorktree/deviceTargets";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { cn } from "@/lib/utils";
import type { Project } from "@shared/schemas";
import {
  DeviceTabBar,
  DeviceTabPanel,
  usePickedDevice,
  type DeviceTab,
} from "./DeviceTabs";

type Holder = DeviceTab & { project: Project };

function holderOf(target: DeviceTarget & { project: Project }): Holder {
  return {
    deviceId: target.deviceId,
    label: target.label,
    isThisDevice: target.isThisDevice,
    status: target.status,
    api: target.api,
    // A holder is never "no-project"; the other two blocks carry over.
    block: target.block === "no-project" ? undefined : target.block,
    project: target.project,
  };
}

export function ProjectDevicePage({
  project,
  title,
  headerExtra,
  children,
}: {
  // The project in hand: the scoped device's own checkout.
  project: Project;
  title: string;
  // Trailing header marks (the terrier paw), before the device chip.
  headerExtra?: ReactNode;
  // The body, given the picked device's copy of the project and, when
  // there is a choice, the tab it came from. It reads everything else
  // through the host-scoped hooks, so it needs no remote-awareness of
  // its own.
  children: (project: Project, tab: DeviceTab | undefined) => ReactNode;
}) {
  const scope = useHostScope();
  const holders = useDeviceTargets(project)
    .filter(
      (target): target is DeviceTarget & { project: Project } =>
        target.project !== undefined,
    )
    .map(holderOf);
  // The tab the page opens on is the device the route named. A route
  // change remounts the page (remountDeps), so this never goes stale.
  const [picked, pick] = usePickedDevice(holders, scope.deviceId);
  const tabbed = holders.length > 1 && picked !== undefined;

  return (
    <div className="flex h-full flex-col">
      <header
        className={cn(
          "flex flex-col border-b border-border px-6 pb-4",
          // The tab bar leads the header and sits on the window's
          // traffic-light line, closer to the edge than a title ever
          // does; everything under it, the title row included, is
          // about the picked device's copy.
          tabbed ? "pt-4" : "pt-7",
        )}
      >
        {tabbed && (
          <DeviceTabBar
            tabs={holders}
            selectedId={picked.deviceId}
            onSelect={pick}
            className="-mx-6 mb-3 px-6"
          />
        )}
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-xs text-muted-foreground">
              {project.name}
            </span>
            <h1 className="text-lg font-medium tracking-tight">{title}</h1>
          </div>
          {headerExtra}
          {/* With tabs they name the device; without them the chip does,
              for a peer's project (nothing locally). */}
          {!tabbed && <DeviceChip />}
        </div>
      </header>
      {tabbed ? (
        <DeviceTabPanel tab={picked} subject="its copy of this project">
          {children(picked.project, picked)}
        </DeviceTabPanel>
      ) : (
        children(project, undefined)
      )}
    </div>
  );
}
