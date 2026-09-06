// The frame every project page shares (configure, manage branches,
// worktree location, convert external): a header led by a tab bar with
// one tab per device that holds the repo. Each device keeps its own
// project file, branches and worktrees, so the body is the picked
// device's copy, mounted under its HostScope exactly as the
// new-worktree page moves its form between devices, and picking
// another tab swaps whose copy the page shows. The tabs are the same
// identity match the new-worktree picker draws (useDeviceTargets),
// less the devices with no checkout of this repo. A project held on
// one device alone gets no tab bar, only the plain chip the worktree
// page wears when it is a peer's (nothing at all locally): there is no
// pick to make.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DeviceChip } from "@/components/remote/DeviceChip";
import { EmptyPanel } from "@/components/remote/EmptyPanel";
import { StatusDot } from "@/components/ui/status-dot";
import {
  useDeviceTargets,
  type DeviceTarget,
} from "@/components/newWorktree/deviceTargets";
import { HostScopeProvider, useHostScope } from "@/hooks/remote/useHostScope";
import { cn } from "@/lib/utils";
import type { Project } from "@shared/schemas";

type Holder = DeviceTarget & { project: Project };

export function ProjectDevicePage({
  project,
  title,
  headerExtra,
  children,
}: {
  // The project in hand: the scoped device's own checkout.
  project: Project;
  title: string;
  // Trailing header marks (the terrier paw), before the device pills.
  headerExtra?: ReactNode;
  // The body, given the picked device's copy of the project. It reads
  // everything else through the host-scoped hooks, so it needs no
  // remote-awareness of its own.
  children: (project: Project) => ReactNode;
}) {
  const scope = useHostScope();
  const holders = useDeviceTargets(project).filter(
    (target): target is Holder => target.project !== undefined,
  );
  // The pill the page opens on is the device the route named. A route
  // change remounts the page (remountDeps), so this never goes stale.
  const [pickedDeviceId, setPickedDeviceId] = useState(scope.deviceId);
  const picked =
    holders.length > 1
      ? (holders.find((holder) => holder.deviceId === pickedDeviceId) ??
        holders.find((holder) => holder.deviceId === scope.deviceId) ??
        holders[0])
      : undefined;

  return (
    <div className="flex h-full flex-col">
      <header
        className={cn(
          "flex flex-col border-b border-border px-6 pb-4",
          // The tab bar leads the header and sits on the window's
          // traffic-light line, closer to the edge than a title ever
          // does; everything under it, the title row included, is
          // about the picked device's copy.
          picked === undefined ? "pt-7" : "pt-4",
        )}
      >
        {picked !== undefined && (
          <DeviceTabs
            holders={holders}
            selectedId={picked.deviceId}
            onSelect={setPickedDeviceId}
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
          {picked === undefined && <DeviceChip />}
        </div>
      </header>
      {picked === undefined ? (
        children(project)
      ) : picked.api === undefined ? (
        <div className="p-6">
          <EmptyPanel>
            {picked.label} is offline. Its copy of this project loads when it
            reconnects.
          </EmptyPanel>
        </div>
      ) : picked.block === "no-grant" ? (
        // A peer that will not run commands from here: the switch lives
        // on its Devices page, and every page here exists to change
        // something, so say that instead of a body whose every action
        // would be refused.
        <div className="p-6">
          <EmptyPanel>
            {picked.label} doesn&apos;t allow control from other devices yet.
            Allow it on its Devices page to work on its copy of this project
            here.
          </EmptyPanel>
        </div>
      ) : (
        /* Remounted per device: a body seeds from the picked device's
           own answers, so carrying state across would show one device's
           data under another's path. */
        <HostScopeProvider
          key={picked.deviceId}
          deviceId={picked.deviceId}
          api={picked.api}
        >
          {children(picked.project)}
        </HostScopeProvider>
      )}
    </div>
  );
}

// The tab bar: this device first, then every peer holding the repo.
// Each tab is the pill the worktree header marks a device with (its
// connection on the dot; this device has none to report), the picked
// one in the accent fill every selection in the app wears; the rest
// stay the chip's quiet card pill, which doubutsu fills through the
// data-slot once the hairline is gone. One row that scrolls sideways
// past the header's inset when the devices outnumber the width, never
// wrapping, so the title row below keeps its place however many
// machines hold the repo. Left and right arrows move the pick, as tabs
// do. An offline peer stays pickable and says so in the body, rather
// than vanishing and leaving "where did the Thinkpad go" open.
function DeviceTabs({
  holders,
  selectedId,
  onSelect,
}: {
  holders: readonly Holder[];
  selectedId: string;
  onSelect: (deviceId: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the picked tab in view: a route that opens on the last of many
  // devices, an arrow key walking past the edge, or a window narrowed
  // after the pick. The row alone is scrolled (not scrollIntoView,
  // which would also pull every scrolling ancestor), by the same inset
  // the header keeps from the window edge.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reveal = () => {
      const tab = list.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!tab) return;
      const inset = 24;
      const edge = list.getBoundingClientRect();
      const box = tab.getBoundingClientRect();
      if (box.left < edge.left + inset) {
        list.scrollLeft += box.left - (edge.left + inset);
      } else if (box.right > edge.right - inset) {
        list.scrollLeft += box.right - (edge.right - inset);
      }
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [selectedId]);

  // On the tabs themselves (the focusable ones, by roving tabindex),
  // so the bar needs no focus stop of its own.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = holders.findIndex((holder) => holder.deviceId === selectedId);
    const next = holders[(index + step + holders.length) % holders.length];
    if (next === undefined) return;
    onSelect(next.deviceId);
    // Focus follows the pick once the new tab is the focusable one.
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.focus();
    });
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Device"
      // Bleeds to the header's edges so a long row scrolls out under
      // the inset rather than clipping at it.
      className="-mx-6 mb-3 flex [scrollbar-width:none] gap-1.5 overflow-x-auto px-6"
    >
      {holders.map((holder) => {
        const selected = holder.deviceId === selectedId;
        return (
          <button
            key={holder.deviceId}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-slot="device-tab"
            title={
              holder.isThisDevice
                ? "This device"
                : `${holder.label} (${holder.status?.label})`
            }
            onClick={() => onSelect(holder.deviceId)}
            onKeyDown={onKeyDown}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
              selected
                ? "border-transparent bg-accent text-accent-foreground"
                : "border-border bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {holder.status && <StatusDot tone={holder.status.tone} />}
            <span className="max-w-40 truncate">{holder.label}</span>
          </button>
        );
      })}
    </div>
  );
}
